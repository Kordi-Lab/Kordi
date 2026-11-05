// Approval page for device code sign-in. The web session lives in an
// HttpOnly cookie; requests send the CSRF token from the session status.
(() => {
  const views = () => document.querySelectorAll('[data-view]');
  const errorBox = () => document.querySelector('[data-error]');
  let csrfToken = '';
  let userCode = '';

  function show(name) {
    for (const view of views()) view.hidden = view.dataset.view !== name;
    setError('');
  }

  function setError(message) {
    const box = errorBox();
    box.textContent = message;
    box.hidden = !message;
  }

  function field(name, value) {
    const node = document.querySelector(`[data-field="${name}"]`);
    node.textContent = value || 'Unknown';
  }

  async function post(path, body) {
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Kordi-CSRF-Token': csrfToken },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: 0, data: { message: 'Could not reach Kordi. Try again.' } };
    }
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    return { ok: response.ok, status: response.status, data };
  }

  function message(result) {
    if (result.status === 429) return 'Too many attempts. Try again shortly.';
    return result.data.message || result.data.error_description || 'Something went wrong. Try again.';
  }

  function formatCode(value) {
    const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  }

  function systemLine(data) {
    const platform = { macos: 'macOS', windows: 'Windows', linux: 'Linux' }[data.platform] || data.platform;
    return [platform, data.osVersion].filter(Boolean).join(' ');
  }

  function locationLine(data) {
    return [data.approximateLocation, data.ipAddress].filter(Boolean).join(' · ');
  }

  function timeLine(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
  }

  async function lookUp(event) {
    event.preventDefault();
    const input = document.getElementById('user-code');
    const code = formatCode(input.value);
    if (code.length !== 9) {
      setError('Enter the 8-character code.');
      return;
    }
    const button = event.target.querySelector('button');
    button.disabled = true;
    const result = await post('/v1/cloud/auth/device/lookup', { userCode: code });
    button.disabled = false;
    if (!result.ok) {
      if (result.status === 401) return show('signin');
      setError(message(result));
      return;
    }
    userCode = code;
    const data = result.data;
    field('device', data.deviceName);
    field('app', [data.appName, data.appVersion].filter(Boolean).join(' '));
    field('system', systemLine(data));
    field('location', locationLine(data));
    field('requested', timeLine(data.requestedAt));
    show('review');
  }

  async function decide(decision) {
    const buttons = document.querySelectorAll('[data-view="review"] button');
    for (const button of buttons) button.disabled = true;
    const result = await post('/v1/cloud/auth/device/decision', { userCode, decision });
    for (const button of buttons) button.disabled = false;
    if (!result.ok) {
      if (result.status === 401) return show('signin');
      if (result.status === 403 || result.status === 404) {
        show('code');
        setError(message(result));
        return;
      }
      setError(message(result));
      return;
    }
    userCode = '';
    show(result.data.status === 'approved' ? 'approved' : 'denied');
  }

  async function start() {
    const input = document.getElementById('user-code');
    input.addEventListener('input', () => {
      input.value = formatCode(input.value);
    });
    document.querySelector('[data-form="code"]').addEventListener('submit', lookUp);
    document.querySelector('[data-action="approve"]').addEventListener('click', () => decide('approve'));
    document.querySelector('[data-action="deny"]').addEventListener('click', () => decide('deny'));
    try {
      const response = await fetch('/v1/cloud/auth/web/session', { credentials: 'include' });
      if (!response.ok) return show('signin');
      const session = await response.json();
      csrfToken = session.csrfToken || '';
      show('code');
      input.focus();
    } catch {
      show('signin');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
