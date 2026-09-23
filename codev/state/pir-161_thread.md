# pir-161 thread

## Plan phase
- #66 is merged; the thread/share GET emit `documents` only when non-empty. Per-tool title/data shapes are in the plan table.
- Surprise: the facilitator prompt already asks the model for inline [N] markers + a "**Citations**:" list. The model's numbering has no link to documents[] order, so the plan proposes strip-always + pills in document order. This departs from the issue's literal "only strip when documents absent" and is flagged for the reviewer.
- Hadith gets no URL (no verified scheme in the repo). Quran → quran.com/S/A.
