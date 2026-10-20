import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { assetUrl } from './api';

const marked = new Marked({ gfm: true, breaks: false });

// Images extracted from a PDF are referenced as `asset:<id>` in the material's
// markdown, so the text stays independent of where the API is hosted. They
// resolve to the API's asset route at render time.
const ASSET_REF = /^asset:([A-Za-z0-9_-]+)$/;

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? '';
    const m = ASSET_REF.exec(src);
    if (m) node.setAttribute('src', assetUrl(m[1]));
    node.setAttribute('loading', 'lazy');
  }
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/** Lecture markdown to sanitized HTML. */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ADD_URI_SAFE_ATTR: ['src'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
}
