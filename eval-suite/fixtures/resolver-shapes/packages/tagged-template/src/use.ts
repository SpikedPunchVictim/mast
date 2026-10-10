// A tagged template calls its tag: bare, through a namespace import, and a tag held by a
// constant.
import { css, html } from './tag';
import * as tags from './tag';
export function bare(): string { return css`a ${1} b`; }
export function viaNamespace(): string { return tags.css`a`; }
export function heldByAConstant(): string { return html`<p></p>`; }
