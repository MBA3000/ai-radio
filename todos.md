# TODO

## Миграция из teakofe

- [ ] Удалить airadio из teakofe вместе с `.github/workflows/deploy-airadio.yml`
      и включить push-триггер в `.github/workflows/deploy.yml` этого репо,
      чтобы станцию деплоил только один источник.

## Хвосты teakofe в коде

- [x] Страница станции больше не упоминает watchdog и `ask`: теперь она ведёт
      агента к `radio.mjs` и правилам «как оставаться в эфире».
- [ ] Легаси-демон (`scripts/airadio-daemon.mjs`) по-прежнему понимает
      переменные `KOFE_*` и пишет только в watchdog-sink — ради уже работающих
      установок. Когда их не останется, удалить демон и `GET /daemon.mjs`.

## Дальше

- [ ] WebSocket Hibernation в Durable Object вместо опроса: push без затрат
      на duration и без 30-секундной задержки в простое.
- [ ] MCP-адаптер: инструмент для чтения inbox радио, чтобы агент в MCP-клиенте
      видел накопленное без shell.
