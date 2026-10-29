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
- [x] Разделить durable intents, внешнее выполнение и подтвержденные результаты.
- [x] Обработать resume/stop/restart и неопределенный результат без слепого повторного запуска.
- [x] Сделать остальные перенесенные views восстановимыми и убрать их авторитетные snapshots; approval bridge уже удален в S1.
- [x] Убрать требования legacy imports/adapters из плана; новые области используют один целевой формат.
- [x] Учесть упорядоченный контекст исторических преобразований и несовместимые переименования JSON-полей.
- [x] Строить отчет из результата одного прогона, сохраняя cleanup и при неуспехе подготовки или команды.

## S6-S7. Удаление обязательной зависимости OpenSpec

- [x] Выделить change package interface и native package implementation.
- [x] Согласовать native package layout без поддержки старого внутреннего формата.
- [x] Перевести corpus comparison и результаты runner с title-based matching на stable ids без legacy mapping.
- [x] Подключить native discovery, author validation, installation, Apply и self-review.
- [x] Генерировать читаемую документацию из контрактов вместо ручного дублирования сценариев.
- [x] Проверить полный native workflow с отсутствующим OpenSpec CLI.
- [x] Переключить разработку Desk на native packages; удалить внутренние compatibility adapters.

## Промежуточный checkpoint S4

- [x] Reviewer и Apply: журнал очередей/попыток, detached worker, receipt recovery, stop/resume и uncertain.
- [x] Research/planner/author: журнал запусков, immutable input/room и safe result, recovery и Git receipts finishers.
- [x] Проверки: отдельные source manifest и receipt, полная приемка отчета, восстановление projection и stale indication.
- [x] Compose verification: отдельный managed container, identity/terminal proof, проверка orphan container на реальном Docker.
- [x] Whole-change approval: durable Git intent/receipt, повтор без второго approval, запрет Apply без подтвержденного commit.
- [x] Общий worktree admission и независимый lock context фоновых observers.
- [x] Общие npm test 88/88, typecheck и self-review 73 contracts / 88 executions / 72 matching review contracts после ALS fix.
- [x] После исправления Stop, ALS lease и детерминированного fake start выполнен финальный полный browser прогон: 13/13. Повторные npm test 88/88, typecheck и self-review прошли также после scanner cache-loss fix.
- [x] Перенести оставшиеся owner Git операции инициатив и создание branch/worktree/первого commit на durable coordination.
- [x] Сохранять coalesced повторную проверку при изменении источников во время активного прогона.
- [x] Добавить durable cleanup verification containers и cleanup browser/proxy/network при retained sandbox receipt.

S4 закрыт общим checkpoint: npm test 101/101, typecheck, self-review 85 corpus contracts / 101 executions / 84 matching review contracts и browser checks 13/13. Owner Git operations и creation coordinator используют immutable inputs и проверяемые receipts. Сохраненная очередь проверок восстанавливается, Stop отменяет ее, terminal контейнеры очищаются по durable intent. Реальные Git hooks после смерти Desk обнаруживаются по собственному и внешнему execution UUID; receipt/retry ждут завершения потомков. Ручные проверки включили concurrent coalescing, source drift, Docker cleanup успешного и rejected отчета, explicit abandonment неизвестной попытки, missing-container uncertainty, 100 MiB captured inputs и 200 MiB materialized copies.

S5-S7 реализованы и прошли общий native checkpoint: npm test 108/108, typecheck, self-review 89 corpus contracts / 108 executions / 88 matching review contracts, browser checks 13/13. Валидный журнал определяет review даже при lost/stale/corrupt YAML. Readers не нормализуют сохраненные факты, неизвестные поля/версии и повторные UUID отклоняются. Replay учитывает исторический prefix; несовместимые переименования требуют явного нового контракта, без импорта старого состояния. Room получает решения всех scopes из журнала. Отчет сохраняет один immutable trace с фактическими наблюдениями и cleanup, без повторного исполнения.

Native packages находятся в desk/changes, инициативы в desk/initiatives. Один canonical path/ID используется parser, corpus, approvals, result producer/consumer и UI. Markdown title join, старый discovery/config/CLI validator и fake OpenSpec удалены; документация контрактов генерируется при чтении. Исторические материалы без исполняемых контрактов перенесены в docs/migrations.

Полный public workflow проверен в disposable Git repository с PATH без OpenSpec: create -> plan -> approve -> author -> scenario/whole approval -> Apply -> matching corpus -> source-bound verification. Restart сохраняет прежний receipt, изменение source делает результат stale. Настоящий Gherkin compiler и strict result consumer проверены на двух вложенных файлах с одинаковыми filename/ID, двумя cases в каждом, title rename, missing-ID и неполным отчетом. Namespace/metadata symlink и snapshot-only initiative storage не скрывают незавершенную работу.

Открытый пункт S0 про дополнительный совместный workshop остается темой для владельца; он не является новым условием выполненной технической миграции S2-S7. Этот список фиксирует разработку и проверки, а не одобрение продуктовых контрактов владельцем.

## На каждом реализованном срезе

- [x] Review конкретного поведения и новых контрактов через Desk без самостоятельной записи approvals агентом.
- [x] Один writer на область, проверяемый cutover и документированные ограничения отката.
- [x] npm test, npm run typecheck, релевантные существующие browser checks.
- [x] npm run test:self при изменениях corpus/runner/self-review.
- [x] Ручная проверка disposable workspace, восстановления views и отсутствия повторных внешних эффектов.

Первый срез approve/revoke реализуется в [scenario-approval-events](../scenario-approval-events/proposal.md).
Остальные approval commands завершены в [approval-command-events](../approval-command-events/proposal.md). S2 описан в discussion-events и owner-decision-events, S3 - в initiative-business-events. S2-S7 завершены по техническим критериям. Подробные условия проверок - в [verification.md](verification.md). Этот список не является записью одобрения владельца.
