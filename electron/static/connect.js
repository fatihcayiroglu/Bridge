// electron/static/connect.js — first-run "connect to your Bridge server" page.
// Runs with no Node access; everything privileged goes through connectPreload.ts.
'use strict';

(async () => {
  const api = window.bridgeConnect;
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const input = $('server');
  const error = $('error');
  const submit = $('submit');

  const { strings, locale, lastOrigin } = await api.getContext();
  document.documentElement.lang = locale;
  document.title = 'Bridge';
  $('title').textContent = strings.connectTitle;
  $('help').textContent = strings.connectHelp;
  $('label').textContent = strings.connectLabel;
  submit.textContent = strings.connectButton;
  input.placeholder = 'chat.example.com';
  if (lastOrigin) input.value = lastOrigin;
  input.focus();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    input.removeAttribute('aria-invalid');
    submit.disabled = true;
    submit.textContent = strings.connecting;
    try {
      const result = await api.connect(input.value);
      if (!result.ok) {
        error.textContent = result.message;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    } finally {
      submit.disabled = false;
      submit.textContent = strings.connectButton;
    }
  });
})();
