# Фактическая проверка MVP

Дата: 25.09.2026, локальное время разработки Asia/Yekaterinburg. Проверки в UTC относятся к 24.09.2026.

## Подтверждено

| Проверка | Результат |
| --- | --- |
| TypeScript build | Проходит |
| Vitest | 45 тестов, 6 файлов, все проходят; dist исключён из test discovery |
| Offline E2E | Fake collector → PostgreSQL → triage → synthesis → проверка evidence → индекс 2 → review → snapshot → approval → fake publisher → deep-link sources/methodology |
| Реальный Supabase | Четыре миграции применены; 55 активных источников, 15 регионов |
| REST/RPC runtime | Успешный доступ; lease захватывается, второй захват отклоняется |
| Health | alive=true, database=true, configured=true; дорогих запросов нет |
| Live SQL integration | Неизменяемость snapshot, запрет добавления источников в готовый snapshot, один выпуск на дату, идемпотентное approval, single publication claim, фиксация message_id; вся fixture-транзакция откатилась |
| Direct collectors | RSS Интерфакс и РБК: успешный HTTP/разбор, по 20 материалов в smoke |
| Security advisor | Нет WARNING/ERROR; INFO об RLS без публичных policies соответствует server-only доступу |
| Secret scan | Текущие секретные значения отсутствуют в Git-visible файлах; `.env.local` игнорируется |
| Runtime dependencies | npm audit --omit=dev: 0 уязвимостей |
| git diff --check | Проходит |

Тесты охватывают URL normalization/dedup, происхождение перепечаток, неверные цитаты, routine/unknown/regional/federal scoring, старые акты, review policy, structured output и retry, расходы, форматирование, deep-link, авторизацию admin, повторное approval, неоднозначную доставку, сверку channel_post, RLS, повторный анализ, сохранение старого snapshot и отказ AI без публикации.

## Не подтверждено / внешние ограничения

Дополнительно реализован защищённый `POST /api/smoke` для проверки провайдеров из Vercel. Тестами подтверждены авторизация до внешних вызовов, разрешённый набор read-only Telegram/DB операций, единственный AI-запрос без retry, изоляция отказов, отдельный статус логирования, отсутствие секретов в ответах и no-store. Сам endpoint в production в рамках этого изменения не вызывался.

1. **xAI live:** HTTP 403, ответ провайдера «This service is not available in your region». Модель не была успешно вызвана. Responses payload, validation, retries и cost parsing проверены имитациями; это не заменяет live-проверку модели и ключа в поддерживаемом регионе.
2. **Telegram live:** `UND_ERR_CONNECT_TIMEOUT` к api.telegram.org. GetMe/права канала не подтверждены. Публикация, callback и личный чат проверены fake Bot API; публичных сообщений не отправлялось.
3. **Deployment:** Vercel deployment не создан в рамках этой проверки; webhook и Supabase Cron не включены. Готовы serverless entrypoints, configuration и activation script.
4. **Coverage:** 9 источников реестра остаются manual/unsupported; универсальный HTML collector не заменяет специализированные API, PDF и динамические страницы. Наличие 55 записей не означает 55 успешно проверенных сайтов.

Прямой Postgres hostname первоначально не разрешался. Проверен session pooler соответствующего проекта, строка подключения сохранена только в `.env.local`. MCP SQL оказался read-only; live SQL integration после этого выполнен через проверенный pooler. Чужой Supabase-проект не изменялся.

## Production gate для владельца

1. Развернуть приложение согласно README в runtime с доступом к xAI и Telegram. Передать серверные env и оставить обязательный review.
2. Выполнить `npm run smoke -- --ai` из среды с доступом к обоим провайдерам; продолжать только при успешном AI и Telegram smoke.
3. Задать APP_URL и выполнить `npm run setup -- --activate` — webhook + минутный Supabase Cron.
4. Выполнить `npm run monitor -- --review-only`; после формирования проверить источники и одобрить один реальный выпуск в admin chat.

Финальная команда полного ручного прогона: `npm run monitor -- --review-only`. Она сама не публикует в канал; публикацию разрешает только admin approval и активная очередь.

## Изменённые части репозитория

- `src/`: конфигурация, domain schemas, collectors, normalization, AIProvider/xAI, intelligence, scoring, reports, PostgreSQL adapter, worker, Telegram, HTTP/local server.
- `api/`, `vercel.json`: health/jobs/telegram endpoints и serverless runtime limits.
- `supabase/migrations/`: четыре воспроизводимые миграции.
- `data/sources.json`, `scripts/import-sources.ts`: реестр и импорт из исходного документа.
- `scripts/`: миграции, secrets setup, activation, dry-run, live smoke, review-only monitor, publication reconciliation, secret scanner.
- `tests/`, `vitest.config.ts`, `.github/workflows/ci.yml`: unit/integration/live rollback tests и CI.
- `package.json`, `package-lock.json`, `.npmrc`, `tsconfig.json`: закреплённые зависимости и сборка.
- `.env.example`, `.gitignore`, `README.md`, `PROJECT_CONTEXT.md`, `IMPLEMENTATION_PLAN.md`: окружение, безопасность и документация.

Исходные продуктовые .txt и изображение не удалены и не изменены. Коммит/push не выполнялись. Полный live E2E пока не объявляется завершённым.
