import { parseIdentity } from './identity.mjs';
export class BindleLoginElement extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:block;font:inherit}label{display:block;font-weight:600;margin-bottom:.5rem}.identity{display:flex;align-items:center;border:1px solid #a9b8bd;border-radius:10px;padding:.8rem;background:#fff}input{min-width:0;border:0;outline:none;flex:1;font:inherit}input:focus{outline:2px solid #276d66;outline-offset:4px}span{color:#697b80}button{margin-top:1rem;padding:.8rem 1rem;font:inherit;background:#145c55;color:white;border:0;border-radius:8px;cursor:pointer}p{font-size:.9rem;color:#5f7277}</style><form><label for="handle">Your Bindle identity</label><div class="identity"><input id="handle" autocomplete="username" autocapitalize="none" spellcheck="false" required aria-describedby="suffix help"><span id="suffix">@3sln.me</span></div><p id="help">Use your handle, or enter a full identity from your own provider.</p><button>Continue</button><p id="status" role="status"></p></form>`;
    const input = root.querySelector('input');
    input.addEventListener('input', () => { root.querySelector('#suffix').hidden = input.value.includes('@'); });
    root.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      try {
        const identity = parseIdentity(input.value);
        root.querySelector('#status').textContent = '';
        this.dispatchEvent(new CustomEvent('bindle-login-request', { detail: identity, bubbles: true, composed: true }));
      } catch (error) { root.querySelector('#status').textContent = error.message; input.focus(); }
    });
  }
}
export function defineLoginElement(name = 'bindle-login') { if (!customElements.get(name)) customElements.define(name, BindleLoginElement); }
