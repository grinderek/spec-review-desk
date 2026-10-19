# Очередь миграции

## Подготовлено в этом change

- [x] Прочитать публичные тексты всех восьми глав и отметить границы исследования.
- [x] Сопоставить идеи с persistence, HTTP workflows, DSL runner и зависимостями OpenSpec.
- [x] Зафиксировать выбранную владельцем цель: ES, затем самостоятельный Desk без обязательного OpenSpec.
- [x] Описать этапы, источники истины, эффекты и ограничения отката; исходный legacy import отменен уточнением владельца.
- [x] Проверить исходный corpus через npm test и TypeScript через npm run typecheck.
- [x] Выполнить существующие 13 browser checks и self-review через npm run test:self.
- [x] Проверить все восемь глав в авторизованной сессии и исследовать доступные примеры кода.
- [x] Разобрать оба видео по полным локальным расшифровкам и последовательности кадров, уточнить план.

## S0. Уточнение модели

- [ ] Пройти с владельцем события и спорные gates для review, initiatives и execution.
- [x] Начать с карты одного review workflow: actor -> view -> command -> event -> view, затем уточнить scope.
- [x] Подготовить первый отдельный behavior-driven change для S1, не меняя утвержденный corpus.
- [x] Определить владельца scope/stream identity, source version и точную границу новых event observations для approve/revoke.

## S1. Первый вертикальный срез

- [x] Выделить обработку ApproveScenario/RevokeScenario: история и входные факты -> решение -> события.
- [x] Подключить production replay и storage adapter для approve/revoke через существующий сериализованный путь.
- [x] Сохранить текущие hashes, public responses и немигрированные YAML-поля; после уточнения владельца убрать чтение старой истории.
- [x] Определить expectedVersion, atomic command batch и единственного writer для review scope до включения нового writer.
- [x] Проверить существующий corpus и восстановление approval view; историческая проверка legacy fixture первого среза заменена отказом чтения старого формата.
- [x] Перенести остальные approval commands; убрать v1, import checkpoints и snapshot diff bridge.

## S2-S5. Бизнес-состояние и восстановление

- [x] Определить review/initiative observation boundaries; сравнивать полную дельту выбранного журнала.
- [x] Перенести discussion identity, messages, status, patch metadata и reviewer session в review stream.
- [x] Перенести owner decisions и явный patch lifecycle в review stream; подтверждать Git effects по receipt.
- [x] Перенести initiative plan, metadata, brief/input refs и research permissions в initiative journal; owner decisions в review journal того же scope, grants коррелируются с их commit.
- [ ] Разделить durable intents, внешнее выполнение и подтвержденные результаты.
- [ ] Обработать resume/stop/restart и неопределенный результат без слепого повторного запуска.
- [ ] Сделать остальные перенесенные views восстановимыми и убрать их авторитетные snapshots; approval bridge уже удален в S1.
- [x] Убрать требования legacy imports/adapters из плана; новые области используют один целевой формат.
- [ ] Учесть упорядоченный контекст исторических преобразований и несовместимые переименования JSON-полей.
- [ ] Строить отчет из результата одного прогона, сохраняя cleanup и при неуспехе подготовки или команды.

## S6-S7. Удаление обязательной зависимости OpenSpec

- [ ] Выделить change package interface и native package implementation.
- [ ] Согласовать native package layout без поддержки старого внутреннего формата.
- [ ] Перевести corpus comparison и результаты runner с title-based matching на stable ids без legacy mapping.
- [ ] Подключить native discovery, author validation, installation, Apply и self-review.
- [ ] Генерировать читаемую документацию из контрактов вместо ручного дублирования сценариев.
- [ ] Проверить полный native workflow с отсутствующим OpenSpec CLI.
- [ ] Переключить разработку Desk на native packages; удалить внутренние compatibility adapters.

## На каждом реализованном срезе

- [ ] Review конкретного поведения и новых контрактов через Desk без самостоятельной записи approvals агентом.
- [ ] Один writer на область, проверяемый cutover и документированные ограничения отката.
- [ ] npm test, npm run typecheck, релевантные существующие browser checks.
- [ ] npm run test:self при изменениях corpus/runner/self-review.
- [ ] Ручная проверка disposable workspace, восстановления views и отсутствия повторных внешних эффектов.

Первый срез approve/revoke реализуется в [scenario-approval-events](../scenario-approval-events/proposal.md).
Остальные approval commands завершены в [approval-command-events](../approval-command-events/proposal.md). S2 описан в discussion-events и owner-decision-events, S3 - в initiative-business-events. S4-S7 остаются открытыми. Этот список не является записью одобрения владельца.
