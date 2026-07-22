import { GoogleGenAI } from '@google/genai';

/* ═══════════════════════════════════════════════════════════════════════
   TaskFlow — Netlify Function: proxy tunggal ke Gemini API.

   Fungsi ini adalah SATU-SATUNYA titik masuk AI di seluruh aplikasi:
   - action: "chat"    → Tanya AI (percakapan bebas, dipakai modal chat).
                          Menerima `context` (snapshot data tugas & mata
                          kuliah dari klien) supaya jawaban relevan, dan
                          boleh mengusulkan SATU aksi tulis data (tambah/
                          ubah/hapus tugas) lewat blok <AI_ACTION>...
                          eksekusi & validasi tetap di sisi klien.
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
const MAX_CONTEXT_CHARS = 6000;     // untuk snapshot data sistem (tugas/mata kuliah)
const MAX_OCR_TEXT_CHARS = 12000;   // untuk teks hasil OCR yang diekstrak

// Instruksi sistem untuk Tanya AI: menyertakan snapshot data sistem (dikirim
// oleh klien sebagai `context`) supaya jawaban AI relevan dengan tugas &
// jadwal kuliah pengguna sesungguhnya, DAN mendefinisikan "protokol aksi"
// yang membatasi AI hanya boleh mengubah data lewat SATU blok JSON
// terstruktur di akhir balasan — bukan bebas menulis apa pun. Eksekusi
// aksi tetap sepenuhnya dilakukan & divalidasi di sisi klien (lihat
// applyAIAction() di index.html), jadi ini hanya "usulan" dari AI.
function buildChatSystemPreamble(contextJson) {
  return `Kamu adalah asisten AI di aplikasi TaskFlow (manajemen tugas kuliah). Jawab dalam Bahasa Indonesia, ringkas, dan relevan.

${contextJson ? `Berikut snapshot data sistem pengguna saat ini (JSON, hanya untuk referensi, jangan ditampilkan mentah-mentah ke pengguna). Manfaatkan SEMUA bagian berikut untuk membuat jawabanmu benar-benar relevan dengan kondisi kuliah pengguna saat ini, bukan cuma daftar tugas mentah:
- today / todayDayName: tanggal & hari ini
- academicPhase: fase kalender akademik saat ini (mis. "Masa UTS", "Masa UAS", "Masa Kuliah 1 (Sebelum UTS)") — pertimbangkan ini saat menyusun rencana belajar (mis. prioritaskan revisi materi kalau sedang mendekati/masuk UTS/UAS)
- stats: ringkasan (total tugas, belum selesai, telat/overdue, jatuh tempo 3 hari ke depan, persentase penyelesaian, sebaran prioritas, total mata kuliah)
- todaySchedule: jadwal kuliah HARI INI (nama matkul, jam, ruangan) — pakai ini kalau ditanya "aku ada kelas apa hari ini" atau saat menyusun rencana belajar di sela jadwal
- courseWorkload: mata kuliah mana yang punya tugas belum selesai terbanyak — pakai untuk menyarankan prioritas belajar
- upcomingHolidays: hari libur terdekat yang sudah diatur pengguna — pertimbangkan saat menyusun rencana belajar/deadline
- courses / tasks: daftar mentah mata kuliah & tugas (dipotong ke item yang paling relevan)
${contextJson}\n` : ''}
Kamu memiliki kemampuan TERBATAS untuk membuat, mengubah, atau menghapus sebagian atau seluruh data TUGAS dan MATA KULIAH (bukan pengaturan lain seperti kalender akademik/hari libur/tema) jika pengguna secara eksplisit memintanya (misal "tambahkan tugas...", "ubah deadline...", "hapus tugas...", "tambahkan mata kuliah...", "ubah jadwal mata kuliah...", "hapus mata kuliah..."). Untuk melakukan itu, sertakan TEPAT SATU blok berikut di BAGIAN PALING AKHIR balasanmu (setelah teks penjelasan biasa untuk pengguna):

<AI_ACTION>{"action":"add_task|update_task|delete_task|add_course|update_course|delete_course","data":{...}}</AI_ACTION>

Aturan blok AI_ACTION:
- Hanya sertakan blok ini jika pengguna benar-benar meminta perubahan data. Jika tidak, JANGAN sertakan blok ini sama sekali.
- Hanya SATU aksi per balasan. Jangan mengarang id — gunakan id persis dari snapshot data sistem di atas.
- Tetap tulis penjelasan singkat untuk pengguna di luar blok AI_ACTION sebelum blok tersebut.

Skema data per aksi TUGAS:
- add_task: {"title":string wajib,"description":string opsional,"courseName":string opsional (cocokkan ke nama mata kuliah di snapshot),"deadline":"YYYY-MM-DD" atau "YYYY-MM-DDTHH:mm" wajib,"priority":"low|medium|high" opsional,"tag":"personal|group" opsional}
- update_task: {"id":string wajib,"title":opsional,"description":opsional,"deadline":opsional,"priority":opsional,"tag":opsional,"completed":boolean opsional}
- delete_task: {"id":string wajib}

Skema data per aksi MATA KULIAH:
- add_course: {"name":string wajib,"code":string opsional,"lecturer":string opsional,"sks":number opsional (default 3),"day":"Senin|Selasa|Rabu|Kamis|Jumat" wajib,"time":"HH:mm-HH:mm" wajib,"room":string opsional,"totalMeetings":number opsional (default 16)}
- update_course: {"id":string wajib (dari snapshot),"name":opsional,"code":opsional,"lecturer":opsional,"sks":opsional,"day":opsional,"time":opsional,"room":opsional,"totalMeetings":opsional}
- delete_course: {"id":string wajib} — ingat ini juga akan menghapus SEMUA tugas yang terkait mata kuliah tersebut, jadi hanya usulkan ini jika pengguna benar-benar memintanya secara eksplisit.

Pertanyaan pengguna:
`;
}


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
        model: 'gemini-3.6-flash',
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

    // action === 'chat' (default) — Tanya AI bebas, dengan konteks data
    // sistem (untuk relevansi) dan protokol aksi terbatas (create/update/
    // delete tugas) yang divalidasi & dieksekusi di sisi klien.
    const { prompt, context: rawContext } = payload;
    if (!prompt || !String(prompt).trim()) {
      return jsonResponse(400, { error: 'Prompt tidak boleh kosong' });
    }

    const trimmedPrompt = String(prompt).slice(0, MAX_PROMPT_CHARS);
    const trimmedContext = rawContext ? String(rawContext).slice(0, MAX_CONTEXT_CHARS) : '';
    const fullPrompt = buildChatSystemPreamble(trimmedContext) + trimmedPrompt;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: fullPrompt,
    });

    return jsonResponse(200, { text: response.text });
  } catch (error) {
    console.error('Error di serverless function:', error);
    return jsonResponse(500, { error: 'Gagal memproses AI: ' + error.message });
  }
}
