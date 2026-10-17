# Text images for downsampling.feature

Each image has a `.txt` file of the same name holding its exact text, the answer key the model's
transcription is scored against.

| Image | Size | What it shows | Answer key source |
| --- | --- | --- | --- |
| `quran-manuscript-shura-zukhruf.jpg` | 830×1269 | Illuminated manuscript page, small dense script | Ash-Shura 42:32–53, Az-Zukhruf 43:1–35 (alquran.cloud `quran-uthmani`) |
| `quran-open-mushaf-maryam-taha.png` | 1134×756 | Open printed mushaf photographed at an angle | Maryam 19:77–98, Ta-Ha 20:1–10 (alquran.cloud) |
| `quran-photo-ahzab.png` | 868×1072 | Phone photo of a printed page, a passage outlined in green | Only the outlined part: Al-Ahzab 33:23–24 and the first three words of 33:25 (alquran.cloud) |
| `quran-photo-hajj.png` | 962×982 | Phone photo of a printed page, a passage outlined in green | Only the outlined part: Al-Hajj 22:11 (alquran.cloud) |
| `quran-whatsapp-baqarah.png` | 1102×1712 | Two WhatsApp screenshots of a Quran app | Al-Baqarah 2:213 (from "فيما") to 2:219 (to "قل العفو"), only the visible part of each cut verse (alquran.cloud) |
| `whatsapp-egyptian-arabic.png` | 1692×990 | WhatsApp message, Egyptian Arabic, no diacritics | Transcribed by hand, typos kept. **Local only:** a personal message, git-ignored and never committed. Runs that have it score 6 images, others 5. |

The Quran keys use only the verses visible in each image. They come from the Uthmani text with full
tashkeel, and `support/text-score.ts` normalises Uthmani spelling conventions so that a correct
reading in normal print spelling scores 97–100% on every page. Margin notes, page numbers and surah
headers are not in the keys; a model that also transcribes them is not penalised.

## Outlined passages

When part of a page is outlined, the answer key is ONLY the outlined part. A user who outlines a
passage is asking about that passage. In the first run Gemini copied exactly the outlined verses:
its scores against the full pages (29.8% and 23.6%) matched the outlined share of each page (28.2%
and 24.8%).

## Limitation

These images are 756–1712 px on their longest side. The app only shrinks images longer than
1568 px, so the 1568 / 2048 / 3072 / original sizes come out almost identical. They measure how well
each model reads Arabic, not what shrinking does. Testing shrinking needs full-resolution phone
photos (3000–4000 px), sent as files rather than through WhatsApp, which compresses them.
