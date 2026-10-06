# pir-228 thread

## Plan phase
- Root cause confirmed: RNW root <Text> defaults dir="auto" (react-native-web Text/index.js:106-108); iOS/Android first-strong too. Single newlines stay inside one paragraph <Text>, so "Arabic line\nEnglish line" (the facilitator's verse+translation shape) is one RTL-based block.
- Plan: detect by Arabic script (not citation matching). Lift Arabic-only lines into a `passage` block (Amiri, RTL, right-aligned); pin every other block LTR (web dir, iOS writingDirection, Android LRM); brass accent rule on quotes holding a passage; whole-answer RTL mode for Arabic/Urdu answers (no lifting).
- Open questions to reviewer: brass rule on unquoted passages? Amiri for inline Arabic runs?
