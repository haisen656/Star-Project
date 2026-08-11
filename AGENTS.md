# QuickDrop engineering rules

- Keep the product accountless: never add visible registration, login, password, email, or profile UI.
- Clients use Supabase Anonymous Auth only. Never expose `service_role` or Edge Function secrets.
- Pairing codes, pairing tokens, device access tokens, IP addresses, and device fingerprints are stored only as keyed hashes.
- Browser clipboard and device clipboard reads must follow an explicit user action. Do not add background collection of clipboard, screen, or files.
- All file bytes live in the private `quickdrop-files` bucket. A file URL must be a server-issued, short-lived signed URL.
- Changes to Supabase authorization require matching migration, Edge Function checks, documentation, and tests where practical.
- Use `pnpm` and keep validation logic in `packages/shared` so web, mobile, and functions follow the same limits.
