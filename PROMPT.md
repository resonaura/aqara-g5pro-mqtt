# Инструкция и технический бриф для ИИ-агента (Reverse Engineering & P2P Stream Unlock)

> **Цель задачи**: Довести до рабочего состояния локальный мост для камеры **Aqara Camera E1** (`lumi.camera.acn006`), чтобы разблокировать входящий видеопоток H.264 по P2P / RTSP и транслировать его в Home Assistant.

---

## 1. Текущий статус проекта и топология

| Устройство | Модель / DID | IP / Порты | Статус |
|---|---|---|---|
| **Outdoor Camera** | Camera Hub G5 Pro (`lumi.camera.agl004`)<br>`lumi3.a5e395b63ce5e6de` | `192.168.5.31`<br>RTSP `8554`, PPPP `32108` | **ПОЛНОСТЬЮ РАБОТАЕТ** (Нативный RTSP `rtsp://292:709@192.168.5.31:8554/ch1` 3K@20fps) |
| **Guinea Pigs Camera** | Camera E1 (`lumi.camera.acn006`)<br>`lumi1.54ef4477da68` | `192.168.4.22`<br>PPPP `32108`, RTSP `554` (Digest `realm="smDgsJ4"`) | **P2P туннель установлен, но 0 видеокадров** (Камера не отдаёт поток в 4-й канал) |

---

## 2. Что УЖЕ полностью решено и работает (НЕ ТРОГАТЬ И НЕ ПЕРЕДЕЛЫВАТЬ)

1. **Облачная авторизация и подпись (Aqara Cloud API)**:
   * Эндпоинт: `https://aiot-rpc-usa.aqara.com/app/v1.0/lumi/user/login`
   * Алгоритм подписи: $\text{sign} = \text{MD5}(\text{Appid}=\dots\ \&\ \text{Nonce}=\dots\ \&\ \text{Time}=\dots\ [\,\&\,\text{Token}=\dots\,]\ \&\ \langle\text{body}\rangle\ \&\ \text{APPKEY})$
   * Секреты: `APP_ID = "444c476ef7135e53330f46e7"`, `APP_KEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi"`
   * `npm run login` в каталоге `app/` работает на чистом TypeScript (никакого Unidbg для авторизации не нужно).

2. **Транспортный уровень PPPP (TUTK/Kalay/PPCS)**:
   * UDP рукопожатие на порт `32108`: `0x30 (LAN_SEARCH)` $\to$ `0x41 (PUNCH)` $\to$ `0x42 (RDY)` $\to$ `0x43 (RDY_ACK)` успешно отрабатывает.
   * Keepalive: пакеты `0xE0` / `0xE1` стабильно циркулируют.
   * Поточный шифр PPCS (таблица `TABLE` 256 байт + ключи из `initStringApp`) полностью отреверсен и работает в `app/src/bridge.ts`.

3. **Дешифровка видеокадров**:
   * Алгоритм: AES-128-CBC с вектором IV (первые 16 байт видео-полезной нагрузки) и ключом из X25519 shared secret.

---

## 3. Точный блокер, который нужно устранить

При запуске тестового скрипта (`npx tsx src/scripts/test_p2p_avio_binary.ts` или `src/scripts/test_e1_p2p_exact.ts`):
1. Камера на `192.168.4.22` принимает PPPP UDP рукопожатие и подтверждает сессию.
2. В канал `Channel 0` отправляется команда `Lumi Login (0x1000)` и запрос старта стрима `CMD_START_STREAM (0x1020)`.
3. **Проблема**: Камера на прошивке `4.5.20_0002` **НЕ шлёт ответных пакетов в Channel 0** и **НЕ начинает трансляцию H.264 кадров в Channel 4** (`Video Frames = 0`).

---

## 4. Данные реверс-инжиниринга APK и прошивки

### А. Найденные структуры в `libdatajar.so` (Android APK)
* Класс `Lcom/lumi/module/p2p/entity/P2pConnectorV2` управляет P2P-сессией.
* Перечисление `PpcsIotType`:
  * `PPCS_IOTYPE_AUTH_REQ` / `PPCS_IOTYPE_AUTH_RESP`
  * `PPCS_IOTYPE_STREAM_START_REQ` / `PPCS_IOTYPE_STREAM_START_RESP`
  * `PPCS_IOTYPE_GET_FRAME_REQ` / `PPCS_IOTYPE_GET_FRAME_RESP`
  * `PPCS_IOTYPE_SET_STREAM_INFO_REQ`
* Бинарный запрос старта: `P2pStreamStartRequest` / `StartVideoCmdContent` (16 байт: `channel=4`, `videoStream=0 (1520p)/1 (1080p)/2 (SD)`, `streamType=0`).

### Б. Данные из прошивки камеры (`niceboygithub/AqaraCameraHubfw`)
* В распакованной прошивке присутствуют:
  * `prog_rtsp` (RTSP сервер на базе Live555, слушающий порт 554).
  * `ha_master`, `ha_matter`, `ha_driven`, `homekitserver`.
* Атрибуты камеры E1 через Cloud API:
  * `model: "lumi.camera.acn006"`
  * `firmwareVersion: "4.5.20_0002"`
  * `supportHomeKit: 1`

---

## 5. Что тебе нужно сделать (План расследования и реализации)

Выбери и доведи до результата наиболее эффективный путь получения видеопотока:

### Вариант 1: Дореверсить бинарный протокол `P2pConnectorV2` (AVIO)
1. Выяснить, какой точный формат ожидает демон камеры при авторизации в Channel 0 (структура `CmdEntity`, бинарный заголовок команды, порядок полей в `PPCS_IOTYPE_AUTH_REQ` / `PPCS_IOTYPE_STREAM_START_REQ`).
2. Проверить, требуется ли перед `DRW (0xD0)` предварительная инициализация `RDT` (Reliable Data Transfer, типы `0x50`/`0x51`/`0x52`).
3. Заставить камеру ответить на Channel 0 и начать пушить кадры H.264 в Channel 4.

### Вариант 2: Локальная аутентификация RTSP на порту 554
1. На `192.168.4.22:554` открыт RTSP-сервер (`WWW-Authenticate: Digest realm="smDgsJ4"`).
2. Выяснить логику формирования/хранения пароля для Digest-аутентификации в демоне `prog_rtsp` (или способ включения анонимного/локального доступа через cloud attribute / matter trait).

### Вариант 3: Локальный Matter / HomeKit стриминг
1. Камера имеет `supportHomeKit: 1` и поддерживает локальное сопряжение HomeKit (HAP over Wi-Fi / SRTP H.264 stream).
2. Проверить возможность прямого захвата видеопотока через [go2rtc](https://github.com/AlexxIT/go2rtc) с локальным HomeKit pairing кодом.

---

## 6. Ключевые файлы и команды для запуска

```bash
# Переход в проект
cd /Users/resonaura/aqara-g5pro-mqtt/app

# Проверка сборки TypeScript
npm run build

# Тест логина в Aqara Cloud и получения списка устройств
AQARA_USER="wertog12@gmail.com" AQARA_PASS="WeRtOG2017!!!!" npm run login

# Тест текущего бинарного AVIO P2P скрипта против Camera E1
npx tsx src/scripts/test_p2p_avio_binary.ts

# Тест RTSP аутентификации на порту 554
python3 src/scripts/test_rtsp_auth_e1.py

# Исходный код моста
# app/src/bridge.ts
# app/src/aqara.ts
# app/src/index.ts
```
