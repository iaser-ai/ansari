export const BRANDING = {
  // Set false to omit the framework credit from the answer footer.
  showSagaCredit: true,
  name: 'Ansari Faithful Answers',
  // Every sentence shown around the card. Each is the application's; the card decides none of them.
  waitingText: 'Waiting for Ansari answer…',
  // The definition's default sentence for a rejection that carries no wording of its own (tool-result.ts words every
  // classified rejection itself). It equals the tool's failure text.
  problemText: 'Ansari could not complete this request.',
  connectFailureText: 'The answer card could not connect. Please retry the question.',
  // The embedded Kitab faces did not load: the host connected, so this is not a connection failure.
  readyFailureText: 'The answer card could not load its fonts. Please retry the question.',
  policyFailureText: 'This view could not start: its content policy is not valid.',
} as const;
