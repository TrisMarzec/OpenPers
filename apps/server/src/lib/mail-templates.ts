import type { MailMessage } from './mailer';

type Locale = 'de' | 'en';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Plain, table-based HTML that renders in Outlook, Gmail and Apple Mail, plus a text part.
 * Only inline styles; no images (many clients block them, SVG logos not at all).
 */
function layout(o: { company: string; heading: string; paragraphs: string[]; button: { label: string; url: string }; footer: string }): Omit<MailMessage, 'to' | 'subject'> {
  const html = `<!doctype html><html><body style="margin:0;padding:0" bgcolor="#f6f7f9">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f6f7f9" style="background-color:#f6f7f9;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#16233f"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="max-width:520px;background-color:#ffffff;border:1px solid #dfe3ea;border-radius:10px">
<tr><td style="padding:22px 28px;border-bottom:1px solid #eef0f4;font-weight:700;font-size:16px;color:#2340c8">${esc(o.company)}</td></tr>
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3">${esc(o.heading)}</h1>
${o.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55">${esc(p)}</p>`).join('\n')}
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0"><tr><td bgcolor="#2340c8" style="background-color:#2340c8;border-radius:8px">
<a href="${esc(o.button.url)}" style="display:inline-block;padding:12px 22px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none">${esc(o.button.label)}</a>
</td></tr></table>
<p style="margin:0;font-size:13px;line-height:1.5;color:#5b6780">${esc(o.footer)}<br><a href="${esc(o.button.url)}" style="color:#2340c8">${esc(o.button.url)}</a></p>
</td></tr></table>
<p style="font-size:12px;color:#8a94a6;margin:16px 0 0">OpenPers</p>
</td></tr></table></body></html>`;
  const text = [o.company, '', o.heading, '', ...o.paragraphs, '', `${o.button.label}: ${o.button.url}`, '', o.footer].join('\n');
  return { html, text };
}

const fmtDate = (d: Date, locale: Locale) => d.toLocaleDateString(locale === 'de' ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

export function inviteMail(o: { locale: Locale; to: string; firstName: string | null; company: string; inviter: string | null; url: string; expiresAt: Date }): MailMessage {
  const de = o.locale === 'de';
  const hello = o.firstName ? (de ? `Hallo ${o.firstName},` : `Hi ${o.firstName},`) : de ? 'Hallo,' : 'Hi,';
  const subject = de ? `Einladung zu OpenPers bei ${o.company}` : `Invitation to OpenPers at ${o.company}`;
  const body = layout({
    company: o.company,
    heading: hello,
    paragraphs: de
      ? [
          `${o.inviter ? `${o.inviter} hat` : 'Dein Team hat'} dich zu OpenPers eingeladen, der Personalsoftware von ${o.company}. Dort beantragst du Urlaub, erfasst Zeiten und findest deine Dokumente.`,
          'Lege jetzt dein Passwort fest – danach bist du direkt angemeldet.',
        ]
      : [
          `${o.inviter ?? 'Your team'} invited you to OpenPers, the HR software of ${o.company}. That is where you request leave, track time and find your documents.`,
          'Choose your password now – you are signed in right after.',
        ],
    button: { label: de ? 'Passwort festlegen' : 'Choose password', url: o.url },
    footer: de ? `Der Link gilt bis ${fmtDate(o.expiresAt, 'de')} und funktioniert nur einmal.` : `The link is valid until ${fmtDate(o.expiresAt, 'en')} and works only once.`,
  });
  return { to: o.to, subject, ...body };
}

export function resetMail(o: { locale: Locale; to: string; firstName: string | null; company: string; url: string }): MailMessage {
  const de = o.locale === 'de';
  const body = layout({
    company: o.company,
    heading: de ? 'Passwort zurücksetzen' : 'Reset your password',
    paragraphs: de
      ? [`${o.firstName ? `Hallo ${o.firstName}, j` : 'J'}emand hat für dein OpenPers-Konto ein neues Passwort angefordert.`, 'Warst du das nicht, kannst du diese E-Mail ignorieren – dein Passwort bleibt unverändert.']
      : [`${o.firstName ? `Hi ${o.firstName}, s` : 'S'}omeone requested a new password for your OpenPers account.`, 'If that was not you, ignore this e-mail – your password stays the same.'],
    button: { label: de ? 'Neues Passwort festlegen' : 'Choose new password', url: o.url },
    footer: de ? 'Der Link gilt eine Stunde und funktioniert nur einmal.' : 'The link is valid for one hour and works only once.',
  });
  return { to: o.to, subject: de ? `Passwort zurücksetzen – ${o.company}` : `Reset your password – ${o.company}`, ...body };
}

export function testMail(o: { locale: Locale; to: string; company: string; url: string }): MailMessage {
  const de = o.locale === 'de';
  const body = layout({
    company: o.company,
    heading: de ? 'Test-E-Mail' : 'Test e-mail',
    paragraphs: [de ? 'Der E-Mail-Versand von OpenPers funktioniert. Einladungen und Passwort-Links kommen an.' : 'E-mail delivery from OpenPers works. Invitations and password links will arrive.'],
    button: { label: de ? 'OpenPers öffnen' : 'Open OpenPers', url: o.url },
    footer: de ? 'Diese E-Mail wurde in den Einstellungen ausgelöst.' : 'This e-mail was triggered in the settings.',
  });
  return { to: o.to, subject: de ? `Test-E-Mail von OpenPers – ${o.company}` : `Test e-mail from OpenPers – ${o.company}`, ...body };
}
