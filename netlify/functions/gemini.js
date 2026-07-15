import { GoogleGenAI } from '@google/genai';

export async function handler(event, context) {
  // Hanya izinkan metode POST untuk mengirim prompt
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Metode Tidak Diizinkan. Gunakan POST.' }),
    };
  }

  try {
    // Ambil prompt yang dikirim oleh frontend Anda
    const { prompt } = JSON.parse(event.body);

    if (!prompt) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Prompt tidak boleh kosong' }),
      };
    }

    // Ambil API Key secara aman dari environment variable Netlify
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Konfigurasi server bermasalah: API Key tidak ditemukan.' }),
      };
    }

    // Inisialisasi Gemini SDK
    const ai = new GoogleGenAI({ apiKey });

    // Panggil API Gemini
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: prompt,
    });

    // Kembalikan jawaban ke frontend
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: response.text }),
    };
  } catch (error) {
    console.error('Error di serverless function:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Gagal memproses AI: ' + error.message }),
    };
  }
}
