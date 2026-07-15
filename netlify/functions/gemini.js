import { GoogleGenAI } from '@google/genai';

/* ═══════════════════════════════════════════════════════════════════════
   TaskFlow — Netlify Function: proxy tunggal ke Gemini API.

   Fungsi ini adalah SATU-SATUNYA titik masuk AI di seluruh aplikasi:
   - action: "chat"    → Tanya AI (percakapan bebas, dipakai modal chat)
   - action: "extract" → AI sebagai "identifier" tunggal pembacaan visual:
                          menerima teks hasil OCR (KRS, kalender akademik,
                          hari libur) dan mengembalikan data terstruktur
                          (JSON) yang sudah dibersihkan/divalidasi.

   Menyatukan semua pemanggilan AI lewat satu fungsi ini (bukan memanggil
   api.anthropic.com langsung dari browser seperti sebelumnya) supaya:
   1) API key tidak pernah terekspos ke klien,
   2) prompt & format output konsisten di satu tempat,
   3) mudah menerapkan batas pemakaian (lihat MAX_* di bawah) untuk
      mencegah spam yang menguras kuota/token.
   ═══════════════════════════════════════════════════════════════════════ */

// Guardrail dasar di sisi server (pertahanan kedua setelah rate-limit
// client-side). Netlify Functions stateless per-invocation, jadi rate
// limit "jumlah request/hari" ditegakkan di klien (localStorage); di sini
// kita hanya membatasi UKURAN tiap request supaya satu request nakal tidak
// bisa menghabiskan token secara berlebihan.
const MAX_PROMPT_CHARS = 4000;      // untuk chat bebas
const MAX_OCR_TEXT_CHARS = 12000;   // untuk teks hasil OCR yang diekstrak

const EXTRACT_PROMPTS = {
  krs: (text) => `Analisis teks KRS (Kartu Rencana Studi) berikut dan ekstrak informasi mata kuliah dalam format JSON array.

Teks KRS:
${text}

Ekstrak informasi berikut untuk setiap mata kuliah:
- code: Kode mata kuliah (format: W312500016, F032500003, dll)
- name: Nama mata kuliah
- sks: Jumlah SKS (biasanya 2-4, harus angka)
- day: Hari kuliah (Senin, Selasa, Rabu, Kamis, Jumat, Sabtu, Minggu)
- time: Jam kuliah (format: 07:30-10:00, 10:15-12:45, 13:15-15:45)
- room: Ruangan (format: B-301, A-405, C-308, dll)
- lecturer: Nama dosen (jika ada, jika tidak ada tulis "-")

Berikan HANYA JSON array tanpa teks lain, tanpa markdown, tanpa backtick. Jika tidak ada mata kuliah yang bisa dikenali, berikan array kosong []. Contoh:
[{"code":"W312500016","name":"KOMUNIKASI BISNIS","sks":3,"day":"Senin","time":"07:30-10:00","room":"B-301","lecturer":"-"}]`,

  holidays: (text) => `Analisis teks kalender hari libur berikut dan ekstrak daftar hari libur dalam format JSON array.

Teks Kalender Libur:
${text}

Ekstrak SEMUA hari libur yang ditemukan dengan format:
- date: Tanggal dalam format YYYY-MM-DD
- name: Nama hari libur
- type: Jenis libur ("national" untuk libur nasional, "religious" untuk keagamaan, "cuti" untuk cuti bersama)

Berikan HANYA JSON array tanpa teks lain, tanpa markdown, tanpa backtick. Jika tidak ditemukan, berikan array kosong []. Contoh:
[{"date":"2026-01-01","name":"Tahun Baru 2026 Masehi","type":"national"}]`,

  calendar: (text) => `Analisis teks kalender akademik berikut dan ekstrak informasi dalam format JSON.

Teks Kalender Akademik:
${text}

Ekstrak informasi berikut (gunakan format tanggal YYYY-MM-DD, gunakan null jika tidak ditemukan):
- semesterName, class1Start, class1End, utsStart, utsEnd, class2Start, class2End, uasStart, uasEnd, midBreakStart, midBreakEnd

Berikan HANYA JSON object tanpa teks lain, tanpa markdown, tanpa backtick. Contoh:
{"semesterName":"Semester Genap 2025/2026","class1Start":"2026-02-02","class1End":"2026-03-27","utsStart":"2026-03-30","utsEnd":"2026-04-10","class2Start":"2026-04-13","class2End":"2026-06-05","uasStart":"2026-06-08","uasEnd":"2026-06-19","midBreakStart":null,"midBreakEnd":null}`,
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function extractJsonFromText(text) {
  const cleaned = String(text || '').replace(/```json|```/gi, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    const candidate = arrMatch ? arrMatch[0] : (objMatch ? objMatch[0] : null);
    if (!candidate) throw new Error('Respons AI bukan JSON yang valid.');
    return JSON.parse(candidate);
  }
}

export async function handler(event, context) {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Metode Tidak Diizinkan. Gunakan POST.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (_) {
    return jsonResponse(400, { error: 'Body request tidak valid.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, { error: 'Konfigurasi server bermasalah: API Key tidak ditemukan.' });
  }

  const ai = new GoogleGenAI({ apiKey });
  const action = payload.action || 'chat';

  try {
    if (action === 'extract') {
      const { task, text } = payload;
      const buildPrompt = EXTRACT_PROMPTS[task];

      if (!buildPrompt) {
        return jsonResponse(400, { error: `Task ekstraksi "${task}" tidak dikenal.` });
      }
      if (!text || !String(text).trim()) {
        return jsonResponse(400, { error: 'Teks hasil OCR kosong, tidak ada yang bisa diekstrak.' });
      }

      const trimmedText = String(text).slice(0, MAX_OCR_TEXT_CHARS);
      const response = await ai.models.generateContent({
        model: 'gemini-flash-latest',
        contents: buildPrompt(trimmedText),
      });

      let data;
      try {
        data = extractJsonFromText(response.text);
      } catch (parseErr) {
        return jsonResponse(502, { error: 'AI tidak mengembalikan data terstruktur yang valid.' });
      }

      return jsonResponse(200, { data });
    }

    // action === 'chat' (default) — Tanya AI bebas
    const { prompt } = payload;
    if (!prompt || !String(prompt).trim()) {
      return jsonResponse(400, { error: 'Prompt tidak boleh kosong' });
    }

    const trimmedPrompt = String(prompt).slice(0, MAX_PROMPT_CHARS);
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: trimmedPrompt,
    });

    return jsonResponse(200, { text: response.text });
  } catch (error) {
    console.error('Error di serverless function:', error);
    return jsonResponse(500, { error: 'Gagal memproses AI: ' + error.message });
  }
}
