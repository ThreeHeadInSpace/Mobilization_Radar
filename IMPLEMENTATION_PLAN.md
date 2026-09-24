# План реализации РАДАР М

Приоритет: финальное ТЗ → методология сигналов → шаблон поста → источники → старый контекст.

## Аудит
На main отсутствует runtime-код. Существующие продуктовые документы и изображение сохраняются на месте. `.env.local` исключён из Git; проверены только имена переменных. Шаблон поста имеет имя без `(1)`.

## Архитектура
TypeScript / Node 22+, Vercel serverless API без frontend. Supabase Postgres хранит исходные материалы, версии событий, неизменяемые выпуски, очередь, leases, аудит и расходы. Supabase Cron вызывает защищённый worker небольшими порциями. Telegram-канал — продукт; бот — публикация, review и архив источников. xAI Responses через AIProvider извлекает данные; индекс рассчитывает код.

## Этапы
1. Конфигурация, строгие схемы, SQL migrations и защита доступа.
2. Импорт seed registry, HTTP/RSS/Telegram web collectors, URL/hash dedup.
3. xAI triage/synthesis/search, проверка цитат, консервативные цепочки, история.
4. Региональные и федеральные правила, coverage/unknown, официальный baseline отдельно.
5. Короткая сводка, immutable snapshot, транзакционная очередь, review и publisher.
6. Защищённые API, Cron, health, уведомления и расходы.
7. Unit/integration tests на настоящем PostgreSQL (PGlite), dry-run, live read-only smoke.
8. README, PROJECT_CONTEXT и отчёт фактической готовности.

## Решения безопасности
По умолчанию REQUIRE_REVIEW_ALL=true, AUTO_PUBLISH_SAFE_REPORTS=false. Никаких тестовых публичных постов. При неоднозначном результате Telegram sendMessage — publication_unknown и ручная сверка, без автоматического retry. Отсутствие данных не равно нулю. Новый уровень 5 требует свежего официального первоисточника и critical review. Неподтверждённая независимость цепочек не повышает индекс.

## Проверка внешних зависимостей
Использовать имеющиеся credentials только server-side. Доступный через MCP проект Supabase неактивен; соответствие локальному проекту и доступность проверяются отдельно. Не менять чужие проекты. Production deployment/scheduler activation выполняются только после проверки runtime и конфигурации.

## Итог
Все этапы реализации кода выполнены. По точному локальному project ref найден действующий Mobilization-radar; применены четыре миграции, импортирован реестр. Проверены локальный end-to-end dry-run и живая Supabase через session pooler, тестовые SQL записи откатились. Live xAI и Telegram заблокированы доступностью из текущей среды; deployment, webhook и Cron не активированы. Оставшиеся проверки и команды владельца — README.md и docs/VERIFICATION.md.
