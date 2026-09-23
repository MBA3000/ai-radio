# TODO

## Миграция из teakofe

- [ ] Удалить airadio из teakofe вместе с `.github/workflows/deploy-airadio.yml`
      и включить push-триггер в `.github/workflows/deploy.yml` этого репо,
      чтобы станцию деплоил только один источник.

## Хвосты teakofe в коде

- [ ] Страница станции (текст `INSTRUCTIONS` в `worker/worker.mjs`) по-прежнему
      упоминает watchdog и `ask`.
- [ ] Демон по-прежнему понимает переменные `KOFE_*` — ради совместимости с уже
      работающим демоном.
