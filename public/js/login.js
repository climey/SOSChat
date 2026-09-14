(function () {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('error');
  const submit = document.getElementById('submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    submit.disabled = true;
    try {
      await SOS.api('POST', '/api/auth/login', {
        email: document.getElementById('email').value,
        password: document.getElementById('password').value,
      });
      location.href = '/';
    } catch (err) {
      errorEl.textContent = err.message;
    } finally {
      submit.disabled = false;
    }
  });
})();
