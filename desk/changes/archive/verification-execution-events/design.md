# Модель проверки

Источник истины - `.spec-review/verification.events.jsonl`. `verification.json` пересобирается из журнала. Чтение HTTP view не добавляет событий и не запускает команды. История разных прогонов сохраняется отдельно.

Команда создает `VerificationSourceCaptured`, `ExecutionQueued` и `ExecutionAttemptRequested` одной записью. Manifest содержит полный HEAD, SHA256 и mode файлов Git worktree, а также ключи и количество строк контрактов. Незакоммиченные исходники входят в версию; runtime artifacts исключены. Источники повторно проверяются перед dispatch и после результата. Это проверка версии рабочего дерева, а не атомарный filesystem snapshot.

Дочерний worker сохраняет immutable intent, process identity и terminal receipt в `.spec-review/executions/<attempt-id>`. PID проверяется вместе с Linux boot identity и start ticks. Остановка адресуется проверенным процессам; неизвестный исход не разрешает повтор, пока живы процессы прошлой попытки. Stale dispatch callback проверяет последний attempt под тем же scope lock.

Команда получает `DESK_RUN_ID`, `DESK_ATTEMPT_ID`, `DESK_SOURCE_HASH` и `DESK_RESULT_FILE`. Для Cucumber аргумент `{resultFile}` заменяется путем этой попытки. Compose передает тот же контекст внутрь контейнера. Команда обязана писать результат в примонтированный worktree.

Worker запечатывает точные bytes отчета в receipt с SHA256. Чтение immutable artifacts использует ограниченный regular-file FD с O_NOFOLLOW и проверку неизменности; receipt связывается с recorded intent, kind и process identity. Desk проверяет terminal record, принадлежность запуску, полное покрытие cases и отсутствие повторов. Для Cucumber проверяются завершения cases и steps, terminal record и полное покрытие захваченного корпуса; свежесть подтверждается отдельным artifact этой попытки. Неуспешный exit, timeout, остановка или изменение источников не дают исход `done`, даже если файл содержит зеленые строки.

Compose запускает отдельный one-shot контейнер с именем `srd-verification-<attempt-id>` и labels run/attempt через `docker compose run`, без автоматического удаления. Host PID не доказывает завершение команды внутри Docker daemon. Перед приемом результата и явным повтором дополнительно проверяется container identity и terminal state; owner stop адресуется проверенному immutable container ID. Если удаленный dispatch не подтвержден, отсутствие контейнера само по себе не разрешает слепой повтор. Общий worktree admission сериализуется Git lease до scope lock и учитывает review, initiative и verification streams.

После сбоя replay восстанавливает views, recovery наблюдает live worker или принимает его receipt ровно один раз. Recovery не повторяет существующую попытку. Отдельный сохраненный запрос повторной проверки может начать новый логический прогон после завершения предшественника. При явном повторе неизвестная предыдущая попытка остается неизвестной в истории, а `VerificationRetryAuthorized` разрешает новую работу после проверки отсутствия живых процессов и terminal proof контейнера. Runtime receipts содержат отфильтрованный вывод, а не credentials.

Следующий этап после общего checkpoint: native stable identity для YAML/Gherkin и конечный native workflow. Успех, orphan container после SIGKILL host wrapper/client, отказ повторного запуска, остановка по verified ID и явный новый запуск проверены на реальном Docker 29.9.0 с локальным node:24-slim. Все контейнеры и сеть этой ручной проверки удалены.


## Сохраненная очередь и cleanup

`VerificationRerunRequested` сохраняет один coalesced запрос и профиль команды. Повторные запросы во время активной проверки объединяются; новую версию исходников захватывают при активации. `VerificationRerunStarted` атомарно потребляет запрос вместе с intent нового прогона. Неопределенная старая попытка блокирует активацию. Ошибка подготовки сохраняет `VerificationRerunDeferred`; владелец может повторить подготовку или отменить очередь через Stop. Stop записывает отмену очереди и остановку текущей попытки до внешнего сигнала.

После классификации результата и verified terminal container ID журнал сохраняет `VerificationCleanupRequested`. Cleanup удаляет только этот immutable ID, без force, после повторной проверки labels и terminal state. Некорректный отчет остается неуспешным, но не мешает безопасно убрать доказанно завершенный контейнер. Повтор cleanup идемпотентен, результаты и receipts сохраняются. Startup только наблюдает ранее записанный intent и может подтвердить уже отсутствующий контейнер; сам контейнер он не удаляет.

Явный отказ владельца от неизвестной попытки сохраняет `VerificationAbandonedCleanupRequested` после `VerificationRetryAuthorized`, с terminal proof и без поддельного успешного receipt. Следующий запуск начинается только после подтвержденного cleanup. Ошибка Docker CLI, включая ненулевой exit, не доказывает отказ daemon до dispatch: отсутствие контейнера в этом случае оставляет исход uncertain. Незавершенный cleanup удерживает общий worktree gate.
