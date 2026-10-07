# pir-245 thread

- Plan phase: auth moves to a root-mounted Sheet driven by a module store (lib/authSheet.ts, mirrors lib/messageActions.ts). /login and /register become deep-link shims that open the sheet over /. AuthForm.tsx to be deleted. Social buttons are inert with a "not available yet" affordance. Success from a /chat thread returns home (principal change clears the query cache, same as signOut).
