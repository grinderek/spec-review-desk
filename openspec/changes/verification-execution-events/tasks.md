# Проверки и состояние

- [x] Сохранять intent, исходную версию и отдельный receipt проверки.
- [x] Проверять полноту и принадлежность отчета до принятия результата.
- [x] Показывать неизвестный и устаревший результат в публичном состоянии.
- [x] Восстанавливать готовый receipt и пересобирать projection без нового запуска.
- [x] Проверить вручную pass/fail, однократное восстановление receipt, повторный restart, потерю projection и изменение исходников.
- [x] Проверить первые шесть новых verification executions и display pass/fail в общем corpus: npm test 74/74. Новые admission rules требуют следующего общего прогона.
- [ ] Проверить остановку и явный повтор verification через публичные HTTP endpoints.
- [x] Проверить Cucumber outline с двумя cases, missing terminal/step и duplicate pickle rejection через настоящий Gherkin compiler.
- [x] Проверить реальный Compose success, orphan container после SIGKILL host processes, отказ retry, verified stop и explicit fresh attempt.
- [x] Проверить O_NOFOLLOW и cross-binding immutable receipt к intent и process identity.
- [ ] Добавить durable cleanup завершенных verification контейнеров.
- [x] Общий npm test 88/88, typecheck и self-review 73 contracts / 88 executions после общего admission и ALS fix.
- [x] Финальный полный browser checkpoint: 13/13 после исправления Stop и scanner cache-loss proof.
- [ ] Сохранять queued повтор при изменении источников во время активного прогона.
- [ ] Перевести всю цепочку на native stable contract identity в S6-S7.
