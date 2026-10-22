# account

Your account, for the editor and the admin app alike: how you sign in (GitHub, your email, a password), setting or
changing a password, and two-factor (an authenticator app, or a code by email after a password). packages/api's
SIGN-IN.md has the design (C3–C7); the routes are the API's `/account…` (the admin app's under `/admin`).

`src/account.tsx` is Preact. The app passes how it reaches the routes, registers the Web Awesome components the page
uses (button, callout, input, spinner), and calls its styles (the theme's, theme/styles/account) once:

```tsx
import { AccountPage } from "account";
import { accountStyles } from "theme/styles/account";

accountStyles();

<AccountPage api={{ get, submit, loginOf }} />
```

- `get(path)` reads, `submit(path, form)` POSTs a form and answers `{ ok, status, body }` (a refusal's `body.reason`
  is shown in words); `loginOf(githubId)`, optional, names a GitHub account for showing.
- `heading={false}` where the app titles it already (the editor's dialog, packages/editor/shell/account-dialog.tsx).

It's linked (`file:`), not published; each app's build dedupes Preact so there's one copy.
