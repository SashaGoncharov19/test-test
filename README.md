# SwapZone — сайт + система электронных чеков

Три файла, никаких зависимостей и сборки:

| Файл | Что это |
|---|---|
| `index.html` | публичный сайт: расчёт, описание процесса, офис, проверка чека |
| `admin.html` | панель сотрудников: выпуск чеков, погашение, продление, отмена |
| `server.js` | сервер: раздаёт сайт и админку, хранит чеки, отдаёт API |

## Запуск

Нужен Node.js 18 или новее.

```bash
node server.js
```

В консоли появится админ-токен — он же сохраняется в `data/admin-token.txt`.

- сайт: `http://localhost:3000/`
- админка: `http://localhost:3000/admin`

Свой токен и порт:

```bash
PORT=8080 ADMIN_TOKEN=длинный-секретный-токен node server.js
```

### Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `PORT` | 3000 | порт |
| `HOST` | 0.0.0.0 | интерфейс |
| `ADMIN_TOKEN` | генерируется | доступ в админку и к админ-API |
| `DEFAULT_TTL_HOURS` | 48 | срок действия чека по умолчанию |
| `ALLOWED_ORIGIN` | `*` | CORS, если сайт и API на разных доменах |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | — | уведомление в Telegram при выпуске чека |
| `WEBHOOK_URL` | — | внешний вебхук: POST с JSON на каждое событие чека |

## Как работает чек

1. Клиент переводит криптовалюту, менеджер видит зачисление.
2. Менеджер открывает `/admin`, вводит сумму, валюту и срок действия → жмёт «Создать чек».
3. Панель выдаёт код `SZ-XXXXXX` и готовый текст для Telegram (кнопка «Скопировать текст для клиента»).
4. Клиент проверяет код на сайте в блоке «Проверка чека» либо по прямой ссылке `сайт/?check=SZ-XXXXXX` — проверка идёт запросом к серверу, а не «на честном слове».
5. В кассе сотрудник жмёт «Выдано» — чек переходит в статус «Погашен» и повторно использован быть не может.

Статусы: `active` → `redeemed` (выдан), `expired` (истёк срок), `cancelled` (аннулирован).
Просроченный чек можно продлить кнопкой «Продлить» — он снова становится действительным.

## API

Публичный:

```
GET /api/checks/SZ-482913
→ {"code":"SZ-482913","status":"active","amount":18500,"currency":"AED",
   "pickup":"...","issuedAt":"...","expiresAt":"...","redeemedAt":null}
GET /api/health
```

Админский (заголовок `X-Admin-Token: <токен>`):

```
POST /api/admin/checks                      создать чек
GET  /api/admin/checks?status=&q=&limit=    список + статистика
POST /api/admin/checks/:code/redeem         погасить
POST /api/admin/checks/:code/cancel         аннулировать
POST /api/admin/checks/:code/extend         продлить, тело {"hours":48}
```

Пример выпуска чека из консоли или из вашего бота:

```bash
curl -X POST http://localhost:3000/api/admin/checks \
  -H "X-Admin-Token: ВАШ_ТОКЕН" -H "Content-Type: application/json" \
  -d '{"amount":18500,"currency":"AED","cryptoAsset":"USDT","cryptoAmount":5000,
       "rate":3.6725,"client":"@username","ttlHours":48}'
```

Так же чек можно выпускать прямо из Telegram-бота — просто вызывайте этот эндпоинт.

## Данные

- `data/checks.json` — база чеков (атомарная запись, при повреждении файл уводится в бэкап).
- `data/events.log` — журнал событий: создание, погашение, отмена, отказы авторизации.
- `data/admin-token.txt` — токен, если он не задан переменной окружения.

Резервная копия — обычное копирование папки `data`.

## Что заменить перед публикацией

В `index.html`, блок `CFG` в самом начале `<script>`:

```js
var CFG = {
  botUrl: 'https://t.me/SwapZoneBot',  // ваш бот — все кнопки берут ссылку отсюда
  apiBase: ''                          // '' = тот же домен; иначе 'https://api.вашдомен'
};
```

Также замените: `@SwapZoneSupport`, почты `*@swapzone.example`, номер лицензии и название юрлица в блоке «Правовая информация».

В `admin.html` (блок `CFG`) при необходимости поправьте `siteUrl` — адрес публичного сайта для ссылок проверки.

## Продакшн

1. Поставьте сервис за nginx/Caddy с HTTPS — токен админки ходит в заголовке, открытый HTTP использовать нельзя.
2. Ограничьте доступ к `/admin` и `/api/admin/*` по IP или базовой авторизации на уровне прокси — это второй рубеж помимо токена.
3. Держите процесс под systemd или pm2, чтобы он поднимался после перезагрузки.
4. Настройте бэкап папки `data`.

Пример unit-файла systemd:

```ini
[Unit]
Description=SwapZone checks
After=network.target

[Service]
WorkingDirectory=/opt/swapzone
ExecStart=/usr/bin/node /opt/swapzone/server.js
Environment=PORT=3000
Environment=ADMIN_TOKEN=длинный-секретный-токен
Restart=always
User=swapzone

[Install]
WantedBy=multi-user.target
```
