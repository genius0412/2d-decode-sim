import { Markdown } from './markdown';
import { PRIVACY_MD, TERMS_MD, LEGAL_UPDATED, LEGAL_IDENTIFIED, LEGAL_CONTACT } from '../legalText';
import { APP_NAME } from '../seasons';

/**
 * Privacy policy + terms pages. Both are the same shape — an eyebrow, a title, a
 * "last updated" line, and one long Markdown body — so they share `LegalPage` and
 * differ only in their copy (`src/legalText.ts`).
 *
 * These render inside the app shell's `.ds-main`, so they return page content only.
 * The `.legal-md` class widens and enlarges the base `.md` type, which is tuned for
 * short announcement cards and reads too tight for a document this long.
 *
 * A live privacy policy is a prerequisite for the AdSense application, so this page
 * must stay reachable without an account and without JavaScript-gated routing.
 */
function LegalPage({ title, sub, body }: { title: string; sub: string; body: string }) {
  return (
    <>
      <p className="ds-eyebrow">{APP_NAME} · Legal</p>
      <h1 className="ds-h1">{title}</h1>
      <p className="ds-sub">
        {sub} Updated {LEGAL_UPDATED}.
      </p>

      <section className="ds-panel">
        <div className="ds-legal">
          <Markdown text={body} className="md legal-md" />
        </div>
      </section>
    </>
  );
}

export function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      sub="What DSIM collects, why, and how to get rid of it."
      body={PRIVACY_MD}
    />
  );
}

export function Terms() {
  return (
    <>
      {/* A contract that names no party and no governing law is not finished, and
          the failure mode is silent — it renders as a perfectly normal-looking
          page with two bracketed placeholders that everyone's eye slides past.
          This makes it impossible to miss, and it is deliberately visible to
          EVERY visitor rather than dev-only: if it ships unfilled, the person who
          most needs to see it is whoever is about to pay. */}
      {!LEGAL_IDENTIFIED && (
        <p className="legal-warn" role="alert">
          These terms are incomplete: the operator and governing law have not been
          filled in yet. Don’t rely on them. Email {LEGAL_CONTACT} with any question
          about your account or a payment.
        </p>
      )}
      <LegalPage
        title="Terms of Use"
        sub="The rules for using the sim, the servers, and supporter memberships."
        body={TERMS_MD}
      />
    </>
  );
}
