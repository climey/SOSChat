#!/bin/sh
# Garante um Chromium utilizável para a pré-consulta (roda no build do Railway).
# Se o "chromium" do nix estiver no PATH, não faz nada; senão baixa o Chrome for Testing em ./.chrome.
set -u
DIR="${CHROME_CACHE_DIR:-$(pwd)/.chrome}"
if command -v chromium >/dev/null 2>&1 && ! grep -qi snap "$(command -v chromium)" 2>/dev/null; then
  echo "[ensure-chrome] chromium do sistema: $(command -v chromium)"
  exit 0
fi
if ls "$DIR"/chrome/*/chrome-linux64/chrome >/dev/null 2>&1; then
  echo "[ensure-chrome] Chrome for Testing já está em $DIR"
  exit 0
fi
echo "[ensure-chrome] baixando o Chrome for Testing em $DIR"
npx --yes @puppeteer/browsers install chrome@stable --path "$DIR" || echo "[ensure-chrome] download falhou; a pré-consulta vai avisar que está sem Chromium"
exit 0
