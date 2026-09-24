# РАДАР М

Автоматический мониторинг открытых источников с ежедневным выпуском в Telegram-канале. Бот публикует выпуски, показывает сохранённые источники и обслуживает ручную проверку. Индекс 0–5 описывает **новые признаки**, а не вероятность политического решения.

## Состояние реализации

Backend MVP реализован на TypeScript/Node, без публичного frontend. Локальный end-to-end dry-run и интеграционные проверки PostgreSQL проходят. Четыре миграции применены к существующему Supabase; реестр содержит 55 активных источников и 15 регионов. Девять источников требуют специализированных адаптеров и учитываются как пробелы покрытия.

По сообщению владельца, production `/api/smoke` в Vercel успешно проверяет Supabase, Telegram permissions и xAI. Локальный доступ к Telegram ограничен, поэтому активация выполняет Telegram-операции через Vercel. Полный цикл публикации ещё требует проверки владельцем. Подробности: [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Быстрый старт

Нужен Node.js 22 или 24 и npm. Docker для локальных тестов не нужен.

```powershell
git clone https://github.com/ThreeHeadInSpace/Mobilization_Radar.git
cd Mobilization_Radar
npm ci
# Только на новой машине, если .env.local ещё не существует:
Copy-Item .env.example .env.local
# Заполнить .env.local локально, затем:
npm run setup -- --local-secrets
npm run db:migrate
npm run registry -- --apply
npm run build
npm test
npm run dry-run
npm run dev
```

Не заменяйте существующий `.env.local` шаблоном. Файл исключён из Git. Не передавайте ключи в командной строке, чатах или URL браузера. `GET http://localhost:3000/api/health` проверяет конфигурацию и базу без AI-запроса; 200 — готовность, 503 — недоступность зависимости.

## Конфигурация

Все переменные перечислены в `.env.example`; пустые необязательные значения используют defaults.

| Переменные | Назначение / default |
| --- | --- |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `TELEGRAM_ADMIN_CHAT_ID` | Обязательные Telegram credentials |
| `TELEGRAM_OWNER_ID` | Обязателен, если admin chat — группа: только этот пользователь принимает решения |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` | Server-only REST/RPC доступ; publishable key не требуется |
| `XAI_API_KEY` | Обязателен для live-анализа |
| `XAI_BASE_URL` | `https://api.x.ai/v1` |
| `XAI_TRIAGE_MODEL`, `XAI_SYNTHESIS_MODEL` | `grok-4.3`; задаются независимо |
| `CRON_SECRET`, `TELEGRAM_WEBHOOK_SECRET` | Генерируются `setup --local-secrets`; минимум 24 символа |
| `DATABASE_URL` | SSL connection string Supabase direct/session pooler; только migrations/setup/live SQL tests |
| `SUPABASE_DB_PASSWORD` | Альтернатива DATABASE_URL при доступном direct host; runtime не использует |
| `APP_URL` | HTTPS URL deployment; нужен для активации webhook/Cron |
| `APP_TIMEZONE` | `Europe/Moscow`, без ручного прибавления UTC offset |
| `MONITOR_HOURS`, `PUBLICATION_TIME` | `08,15` и `18:00` в APP_TIMEZONE |
| `REQUIRE_REVIEW_ALL` | `true` |
| `AUTO_PUBLISH_SAFE_REPORTS` | `false` |
| `ENABLE_WEB_SEARCH` | `true`; дополнительное discovery, не замена collectors |
| `MONTHLY_AI_BUDGET_USD` | `20`; предупреждение при 80%, без внезапного выключения проверок |
| `MIN_COVERAGE` | `0.6` |
| `REVIEW_LEVEL` | `2` |
| `STRONG_CHAINS`, `FEDERAL_REGIONS` | `3`, `3`; консервативные настраиваемые пороги |

В текущем локальном `.env.local` дополнительно созданы защитные токены и сохранена проверенная строка session pooler. Значения нигде не выводились. Пароль Postgres и DATABASE_URL не нужны в Vercel runtime.

## Миграции

`npm run db:migrate` применяет SQL транзакционно, хранит checksum в `radar_migrations.applied`, распознаёт уже применённые одноимённые Supabase migrations. На новой базе воспроизводит всю схему; создавать таблицы через Dashboard не требуется.

1. `20260924192002_radar_core.sql`: таблицы, RLS, RPC, leases, уникальность выпуска, immutable snapshot, очередь и audit.
2. `20260924192003_radar_scheduler.sql`: pg_cron, pg_net, Vault, защищённый вызов worker; без активации расписания.
3. `20260924194434_radar_reliability.sql`: ожидание HTTP worker и идемпотентное завершение отправки.
4. `20260924195049_radar_usage_totals.sql`: точная серверная агрегация расходов за месяц, включая число запросов с неизвестной стоимостью.

Доступ `anon`/`authenticated` к данным и RPC закрыт. Используются security-invoker функции, фиксированный search_path и server service role. RLS без публичных политик — намеренная архитектура; информационное замечание Supabase `rls_enabled_no_policy` не следует «исправлять» открытием доступа. [Описание проверки Supabase](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).

## Поток данных

```text
Supabase Cron → POST /api/jobs → lease и сохранённая фаза run
  → HTTP / RSS / Telegram web → URL/hash dedup
  → xAI Web Search discovery → прямое чтение найденных страниц
  → triage JSON → synthesis JSON → проверка ссылок и точных цитат
  → история / независимые цепочки → правила индекса
  → отчёт run → ежедневный snapshot → review → очередь → Telegram
```

Один worker tick собирает до трёх источников, анализирует до трёх материалов triage или один synthesis batch из 12 материалов. Прогресс сохраняется в БД, cron вызывает worker каждую минуту. Это позволяет переживать остановки функций без повторного полного сбора. Сетевые обращения ограничены по времени, collectors имеют retry/backoff и независимые результаты. Ошибка AI останавливает анализ без выдуманной сводки.

Сборщики читают публичные страницы Telegram, а не чужие каналы через Bot API. Нет MTProto/userbot и запроса телефона. Неполное извлечение, недоступный сайт и неподдерживаемый источник ухудшают coverage. HTML-адаптер берёт до пяти подходящих ссылок; RSS/Telegram — до 20 недавних материалов. Это ограниченный MVP, не исчерпывающий обход интернета.

`data/sources.json` воспроизводимо генерируется из исходного `Ссылки для анализа.txt` с дополнением региональных официальных адресов. Доступность адреса и качество извлечения определяются каждым запуском, а не самим присутствием в реестре.

## Индекс и история

LLM не выбирает уровень. Zod проверяет structured output; код проверяет наличие каждого articleId, цитаты в исходном тексте и заявленной ссылки-первоисточника в ссылках статьи. Неизвестный origin не добавляет независимых подтверждений. Перепечатки с общей исходной ссылкой, одним издателем или совпадающей цитатой объединяются консервативно.

Обычный призыв, учёт, сборы, контрактники и плановые учения не повышают индекс. Слухи ограничены уровнем 1. Подтверждённая необычная находка даёт 2; две независимые цепочки — 3; массовая активность с дополнительными подтверждениями и разными типами доказательств — 4. Для 5 требуется свежий официальный первоисточник о новом юридическом действии; всегда critical review. Неактуальный акт не поднимает ежедневный индекс до 5.

Региональные показатели независимы. Локальная активность ограничивает федеральное повышение; один регион с 4 не превращает весь федеральный показатель в 4. При coverage ниже порога и отсутствии активных находок возвращается `level: null`, а не 0. Неохваченные регионы вне реестра также нельзя считать проверенными.

`official_baseline` — отдельный накопленный реестр обнаруженных официальных действий, без исходного хардкода юридического статуса. До review это результаты анализа, не юридическая экспертиза. Классификация изменений: новое событие, без изменения, новое подтверждение, изменение статуса. Динамика стрелки сравнивается с последним **опубликованным** выпуском.

## Review, архив и публикация

По умолчанию каждый выпуск ждёт review. Даже при отключении общего review остаются порог индекса, противоречия, неполное покрытие, недостаточная уверенность и юридические действия.

Администратор получает индекс, предыдущий уровень, изменения, регионы, независимые цепочки и ссылки. Кнопки: источники, одобрить, отклонить, повторить анализ. Callback проверяет личность и chat; SQL блокирует очередь и пишет audit. Одобрение переводит в `ready`; следующий tick выполняет smoke Telegram и отправку.

Повторный анализ блокирует прежний черновик, запускает новую проверку, сохраняет старый snapshot и после успеха создаёт новую редакцию. Опубликованные выпуски не заменяются. Пока повторный анализ не завершён, старый черновик не публикуется.

Ежедневный выпуск уникален по локальной дате среди действующих редакций. `summaries.data` и `summary_sources` после формирования неизменяемы. Deep-link `sources_<24 hex chars>` всегда относится к конкретному выпуску. Бот берёт источники из сохранённого отчёта, не обращаясь к AI. `methodology_v1` — статическая версия методологии. Пользователю не выдаются неопубликованные черновики.

Telegram Bot API не обеспечивает exactly-once доставку. Реализована политика **не повторять неоднозначную отправку**: `ready → sending → published`, при тайм-ауте `unknown`. После crash зависшая `sending` также становится `unknown`. Повторный send запрещён; при получении совпадающего `channel_post` сообщение сверяется автоматически. Если Telegram не прислал update, владелец проверяет канал и записывает существующий message_id:

```powershell
npm run reconcile -- PUBLIC_ID VERIFIED_TELEGRAM_MESSAGE_ID
```

Эта команда ничего не отправляет. Автоматического сброса `unknown → ready` нет. Это предотвращает дубли ценой возможного пропуска выпуска до ручной сверки.

## Проверки

```powershell
npm run build
npm test
npm run dry-run
npm run smoke:db
npm run test:db:live
npm run smoke -- --ai
```

`dry-run`: настоящая локальная PostgreSQL через PGlite, fake source/AI/Telegram; проходит от collector до approval, публикации, sources и methodology. Внешних вызовов нет. `test:db:live`: откатываемая транзакция на настоящем Supabase, без Telegram. `smoke --ai`: реальный getMe, проверка admin/channel прав, два RSS и небольшой платный xAI triage; в канал не пишет. Расходы/ошибки AI пишутся в `ai_usage`; стоимость берётся из `cost_in_usd_ticks / 1e10`, отсутствие стоимости остаётся null.

### Production smoke из Vercel

`POST /api/smoke` требует `Authorization: Bearer CRON_SECRET`. Проверки выполняются внутри serverless-функции Vercel: чтение Supabase, Telegram `getMe`, admin chat, channel, `getChatMember` с явной проверкой права публикации, один минимальный xAI triage. Тело запроса игнорируется. AI не повторяется при ошибке, web search отключён, ответ ограничен 512 токенами. Каждый сетевой запрос ограничен 15 секундами; лимит функции — 60 секунд.

Endpoint не отправляет сообщения, не регистрирует webhook, не запускает worker/monitoring и не меняет таблицы проекта, кроме одной попытки записи `ai_usage` с `operation=smoke_triage`, `run_id=null`. Это небольшой платный AI-запрос, поэтому endpoint не следует использовать как регулярный healthcheck.

Для вызова после deployment можно использовать PowerShell, если `APP_URL` и `CRON_SECRET` уже установлены в окружении терминала:

```powershell
Invoke-RestMethod -Method Post -Uri "$env:APP_URL/api/smoke" -Headers @{ Authorization = "Bearer $env:CRON_SECRET" }
```

`200` означает успех всех проверок; `503` возвращает раздельные статусы `supabase`, `telegramGetMe`, `telegramAdminChat`, `telegramChannel`, `telegramPermissions`, `xai`, `aiUsage`. Недоступность одного сервиса не отменяет независимые проверки других. Не выполненные зависимые проверки имеют статус `skipped`. `401` — неверный/отсутствующий секрет, `405` — метод отличается от POST. Ответы имеют `Cache-Control: no-store`, не содержат ключей, chat IDs, исходного ответа AI или текста исключений провайдеров.

После доступности xAI и Telegram полный реальный прогон **без публикации в канал**:

```powershell
npm run monitor -- --review-only
```

Он сохраняет run и после времени выпуска формирует черновик для администратора. В активном расписании одобрение разрешает следующему worker tick опубликовать выпуск. До включения расписания команда сама не отправляет пост в канал. Качество первых выпусков нужно проверить вручную; `REQUIRE_REVIEW_ALL=true` сохраняется.

## Deployment на Vercel

1. Импортировать repository, Framework Preset **Other**, Node 22/24. Build command `npm run build`; `api/*.ts` — серверные функции. Настройки лимитов уже в `vercel.json`. Для worker нужен тариф/runtime с поддержкой 240 секунд.
2. В Environment Variables добавить runtime credentials из `.env.local`, включая оба защитных токена. Не использовать `NEXT_PUBLIC_*`. Сохранить `REQUIRE_REVIEW_ALL=true`, `AUTO_PUBLISH_SAFE_REPORTS=false`.
3. Разместить runtime в регионе, где доступен xAI по условиям провайдера. В текущей среде 403; не считать смену URL или модели исправлением регионального запрета.
4. Проверить deployment `/api/health`, затем защищённый production `/api/smoke`. Задать одинаковый `APP_URL` в Vercel и локальном `.env.local`: корневой HTTPS URL без пути, query или credentials. Использовать существующие `CRON_SECRET` и `TELEGRAM_WEBHOOK_SECRET`; локальный `CRON_SECRET` должен совпадать с Vercel.
5. После deployment выполнить **`npm run setup -- --activate`**. Локальная команда проверяет health и вызывает защищённый endpoint Vercel `POST /api/setup/telegram`. Vercel проверяет Telegram и регистрирует webhook; только после успеха локальная команда через `DATABASE_URL` сохраняет настройки в Supabase Vault и включает минутный pg_cron job. Повторный запуск обновляет одну именованную задачу `radar-worker` для того же пользователя БД. Vault и Cron настраиваются в одной транзакции; существующий секрет не заменяется, при несовпадении активация останавливается. Vercel Cron не используется.
6. Выполнить `npm run monitor -- --review-only`, проверить полученный черновик и источники. Одобрить один реальный выпуск в admin chat.

Публичные API: `GET /api/health`, `POST /api/jobs`, `POST /api/smoke`, `POST /api/setup/telegram` (Bearer CRON_SECRET), `POST /api/telegram` (Telegram secret header). Анонимный посетитель не может запускать анализ. Если включена Vercel Deployment Protection, production endpoints должны быть доступны вызывающим клиентам с собственными проверками авторизации приложения.

`POST /api/setup/telegram` не принимает настройки из тела запроса: он использует только серверные env, выполняет Telegram smoke и `setWebhook` на `${APP_URL}/api/telegram` с `TELEGRAM_WEBHOOK_SECRET`, сохраняя ожидающие updates. Он не публикует сообщения, не запускает monitoring и не обращается к AI или БД. Успех: `{"ok":true,"telegram":"ok","webhook":"registered"}`. Ошибки возвращают только фиксированные безопасные коды, ответы имеют `Cache-Control: no-store`. Повторная регистрация того же webhook допустима. Если последующая настройка БД завершилась ошибкой, webhook остаётся зарегистрированным; команду можно повторить после устранения ошибки.

## Структура и таблицы

`src/collectors`, `normalization`, `providers`, `intelligence`, `scoring`, `reports`, `telegram`, `database`, `jobs`, `config` разделяют ответственность. `api/` содержит тонкие HTTP endpoints; `scripts/` — операции; `tests/` — проверки.

| Таблицы | Назначение |
| --- | --- |
| sources, articles | Реестр и нормализованные материалы |
| monitor_runs, collector_runs, run_articles | Прогресс, ошибки и triage |
| findings, finding_sources | История фактов и доказательств |
| signal_snapshots, official_baseline | Региональные/федеральные оценки и отдельный юридический слой |
| run_reports | Результат каждой внутренней проверки |
| summaries, summary_sources | Неизменяемые выпуски и источники |
| publication_queue, admin_jobs | Публикация и повторный анализ |
| ai_usage, audit_log | Расходы, ошибки, решения |
| config, job_locks | Служебная конфигурация и leases |

## Ограничения MVP

- Полнота не гарантируется: динамические сайты, anti-bot, PDF-документы, авторизованные реестры, TGStat/Trends/закупки требуют отдельных адаптеров. Эти пробелы видны в coverage.
- Независимость и семантическая идентичность частично извлекаются моделью; точные цитаты и консервативные правила уменьшают ошибки, но не заменяют редакторскую проверку.
- История для synthesis ограничена 200 последними findings, обработка материалов и отчётов имеет bounded batches. Для роста объёма нужны pagination, архивный поиск и калибровка порогов.
- Если анализ не успел к 18:00, выпуск задерживается до завершения/review. При полном отказе AI публикации нет. Автоматический breaking-news режим отсутствует.
- Production smoke подтверждён владельцем; это не заменяет полный live E2E с активацией, ручной проверкой и публикацией выпуска.

Исходные методология, шаблон поста, реестр ссылок и изображение сохранены на месте. [Актуальная архитектура](PROJECT_CONTEXT.md), [план реализации](IMPLEMENTATION_PLAN.md).
