/**
 * Brand hierarchy for the assistant and the site that hosts it.
 *
 * Three names are easy to conflate, and conflating them is what made the
 * disclosure introduce a brand the visitor had never heard of:
 *
 *  - **LifeChat** — the assistant/product a visitor talks to (this repository).
 *  - **Life Insurance Broker Advocate** — the brokerage brand and website that
 *    embeds it (`lifeinsurancebrokeradvocate.com`, `WEBSITE_URL`).
 *  - **Richard Parslow** — the licensed Texas broker behind both.
 *
 * Display convention wherever a visitor sees the product and the provider
 * together: "LifeChat by Life Insurance Broker Advocate". The assistant is
 * "LifeChat", never a separate product name; the provider is the broker brand.
 *
 * `public/widget.js` is a standalone ES5 file with no build step, so it cannot
 * import this module. It carries the same strings as constants; a test
 * (`tests/branding.test.ts`) fails if the two drift.
 */

/** The assistant/product name. */
export const PRODUCT_NAME = 'LifeChat';

/** The brokerage brand that hosts and provides the assistant. */
export const PROVIDER_BRAND = 'Life Insurance Broker Advocate';

/** The display form when both names are shown: "LifeChat by …". */
export const PRODUCT_DISPLAY_NAME = `${PRODUCT_NAME} by ${PROVIDER_BRAND}`;

/** What the assistant is, used mid-sentence ("LifeChat, the …"). */
export const ASSISTANT_ROLE = 'AI educational assistant';

/** Sentence-form identity for disclosures: "LifeChat, the AI educational …". */
export const ASSISTANT_IDENTITY = `${PRODUCT_NAME}, the ${ASSISTANT_ROLE} from ${PROVIDER_BRAND}`;

/** Single-name form for product metadata and headings. */
export const ASSISTANT_DISPLAY_NAME = `${PRODUCT_NAME} AI Educational Assistant`;
