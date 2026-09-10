/**
 * login.ts – the two password gates: read-only viewer and admin.
 */
import { layout, esc, brandMark, type Theme } from "./layout";

interface LoginOptions {
  theme: Theme;
  title: string;
  subtitle: string;
  action: string; // POST target
  buttonLabel: string;
  error?: string;
  footer?: string; // link shown under the form
}

function loginPage(opts: LoginOptions): string {
  const body = `<div class="login-wrap">
    <div class="login-card">
      ${brandMark(opts.theme, "login")}
      <div class="login-title">${esc(opts.title)}</div>
      <div class="login-sub">${esc(opts.subtitle)}</div>
      <div class="card">
        ${opts.error ? `<div class="message error">${esc(opts.error)}</div>` : ""}
        <form method="post" action="${esc(opts.action)}">
          <div class="form-group">
            <label for="password">Password</label>
            <input type="password" id="password" name="password" autocomplete="current-password" autofocus required>
          </div>
          <button type="submit" class="btn btn-primary btn-block">${esc(opts.buttonLabel)}</button>
        </form>
      </div>
      ${opts.footer ? `<div class="login-foot">${opts.footer}</div>` : ""}
    </div>
  </div>`;

  // The viewer gate's heading is already the brand label, so don't repeat it
  // in the tab title.
  const tabTitle = opts.title === opts.theme.brandLabel ? opts.title : `${opts.title} · ${opts.theme.brandLabel}`;
  return layout({ title: tabTitle, body, theme: opts.theme });
}

export function viewerLoginPage(theme: Theme, error?: string): string {
  return loginPage({
    theme,
    title: theme.brandLabel,
    subtitle: "Enter your password to see the sync status.",
    action: "/login",
    buttonLabel: "Sign in",
    error,
    footer: `<a href="/settings/login">Admin sign in</a>`,
  });
}

export function adminLoginPage(theme: Theme, error?: string): string {
  return loginPage({
    theme,
    title: "Admin sign in",
    subtitle: "Enter the admin password to configure the sync.",
    action: "/settings/login",
    buttonLabel: "Sign in",
    error,
    footer: `<a href="/login">Back to the standard sign in</a>`,
  });
}
