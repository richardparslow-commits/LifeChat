/**
 * Brand hierarchy: the assistant is **LifeChat**, the provider is **Life
 * Insurance Broker Advocate**, and the licensed human is Richard Parslow.
 *
 * The widget is a standalone ES5 file that cannot import the TypeScript
 * constants, so the duplication is real and has to be pinned rather than
 * hoped for. These tests fail if the two drift, if a retired brand returns to
 * a current-facing file, or if the served disclosure stops naming the provider.
 */

import { readFileSync } from 'fs';
import path from 'path';

import {
  ASSISTANT_DISPLAY_NAME,
  ASSISTANT_IDENTITY,
  PRODUCT_DISPLAY_NAME,
  PRODUCT_NAME,
  PROVIDER_BRAND,
} from '../src/config/branding';
import { PRODUCT_DEFINITION, config } from '../src/config/app-config';
import { BEFORE_CHAT_BANNER, getFirstMessageDisclosure } from '../src/prompts/system-prompt';

const ROOT = path.join(__dirname, '..');
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), 'utf8');

describe('brand constants', () => {
  it('names the product, the provider and the display form explicitly', () => {
    expect(PRODUCT_NAME).toBe('LifeChat');
    expect(PROVIDER_BRAND).toBe('Life Insurance Broker Advocate');
    expect(PRODUCT_DISPLAY_NAME).toBe('LifeChat by Life Insurance Broker Advocate');
    expect(ASSISTANT_DISPLAY_NAME).toBe('LifeChat AI Educational Assistant');
    expect(ASSISTANT_IDENTITY).toBe(
      'LifeChat, the AI educational assistant from Life Insurance Broker Advocate',
    );
  });

  it('drives the product definition and the business name from those constants', () => {
    expect(PRODUCT_DEFINITION.name).toBe(ASSISTANT_DISPLAY_NAME);
    expect(PRODUCT_DEFINITION.owner).toContain(PROVIDER_BRAND);
    expect(config.businessName).toBe(PRODUCT_NAME);
  });
});

describe('served disclosure', () => {
  it('introduces the assistant as LifeChat and names the provider', () => {
    const disclosure = getFirstMessageDisclosure();
    expect(disclosure.startsWith(`I'm ${ASSISTANT_IDENTITY}.`)).toBe(true);
    expect(disclosure).toContain(PROVIDER_BRAND);
    // The compliance lines are unchanged by the rename.
    expect(disclosure).toContain('I am not a licensed person');
    expect(disclosure).toContain("Please don't share medical history");
  });

  it('keeps the before-chat banner free of a product name it cannot keep in sync', () => {
    // The banner is about AI and sensitive data; naming a product there would
    // create a second place to update on every brand change.
    expect(BEFORE_CHAT_BANNER).toContain('AI educational assistant');
    expect(BEFORE_CHAT_BANNER).not.toContain(PRODUCT_NAME);
    expect(BEFORE_CHAT_BANNER).not.toContain(PROVIDER_BRAND);
  });
});

describe('widget branding stays identical to the module', () => {
  const widget = read('public/widget.js');

  it('declares the same three strings as src/config/branding.ts', () => {
    expect(widget).toContain(`var PRODUCT_NAME = '${PRODUCT_NAME}';`);
    expect(widget).toContain(`var PROVIDER_BRAND = '${PROVIDER_BRAND}';`);
    expect(widget).toContain("var PRODUCT_DISPLAY_NAME = PRODUCT_NAME + ' by ' + PROVIDER_BRAND;");
    // The header and the launcher's accessible name use those constants.
    expect(widget).toContain('title.textContent = PRODUCT_DISPLAY_NAME;');
    expect(widget).toContain("'Chat with ' + PRODUCT_NAME");
  });

  it('renders the display name the API sends', () => {
    // One source for the value a visitor sees: the disclosure payload.
    expect(widget).toContain('data.productDisplayName');
  });
});

describe('retired brand', () => {
  it('appears nowhere in the code, widget or current-facing documents', () => {
    const currentFacing = [
      'src/prompts/system-prompt.ts',
      'src/rag/retrieval.ts',
      'src/rag/rag-architecture.ts',
      'src/contextual/article-map.ts',
      'src/state-machine/state-machine.ts',
      'src/accessibility/accessibility.ts',
      'src/evaluation/golden-set.ts',
      'src/consent/consent-copy.ts',
      'src/consent/consent-model.ts',
      'public/widget.js',
      'public/demo.html',
      'README.md',
      'docs/privacy-notice.md',
      'docs/ai-chatbot-persona-configuration.md',
      'docs/compliance-classification-matrix.md',
      'docs/subprocessors.md',
      'docs/section-508-accessibility-review.md',
      '.env.example',
    ];

    for (const file of currentFacing) {
      expect({ file, found: read(file).includes('Life Policy Pilot') }).toEqual({
        file,
        found: false,
      });
    }
  });

  it('is still named in the migration audit, which is the record of the change', () => {
    // Historical and decision records keep the old name on purpose; erasing it
    // would make the migration unreadable.
    expect(read('docs/lovable-migration-readiness-audit.md')).toContain('Life Policy Pilot');
  });
});
