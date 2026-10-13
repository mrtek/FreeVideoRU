<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="web/assets/freevideo.svg">
    <img alt="FreeVideo" src="web/assets/freevideo-light.svg" width="65%">
  </picture>
</div>

<p align="center">
| <a href="https://github.com/mrtek/FreeVideoRU/releases/latest/download/FreeVideoRU.exe"><b>Windows</b></a> | <a href="https://github.com/FlashML-org/FreeVideo/releases/latest/download/FreeVideo-Mac-arm64.dmg"><b>macOS</b></a> | <a href="https://github.com/FlashML-org/FreeVideo/releases/latest/download/FreeVideo-Linux-x86_64.AppImage"><b>Linux</b></a> | <a href="docs/community-results.md"><b>Тесты сообщества</b></a> | <a href="https://freevideo-community.pages.dev/#gallery"><b>Галерея</b></a> | <a href="https://discord.gg/MsA277cJzZ"><b>Discord</b></a> | <a href="https://freevideo-community.pages.dev/qq"><b>Группа QQ</b></a> | <a href="https://freevideo-community.pages.dev/wechat"><b>Группа WeChat</b></a> |
</p>

<p align="center">Русский · <a href="README.en.md">English</a> · <a href="README.zh-CN.md">中文</a></p>

Создавайте видео на компьютере, который у вас уже есть. Благодаря [Video DeltaNet (VDN)](https://openvdn.github.io/), FreeVideo запускает MiniMax H3 всего на 8 ГБ видеопамяти (VRAM) и 16 ГБ оперативной памяти (RAM), подбирая оптимальное аппаратное ускорение под вашу систему.

https://github.com/user-attachments/assets/ecda7d0d-7fbe-4e0c-8c29-8f3315bafc15

<p align="center"><a href="https://freevideo-community.pages.dev/#gallery">Больше видеоклипов и сравнение четырех уровней качества в галерее →</a></p>

## Новости

- **2026-10-07** · **[v0.3.2](https://github.com/FlashML-org/FreeVideo/releases/tag/v0.3.2): сначала предпросмотр.** Быстрый предпросмотр в половинном разрешении позволяет оценить результат и завершить рендеринг только тех видео, которые вам нравятся.
- **2026-10-07** · **[v0.3.0](https://github.com/FlashML-org/FreeVideo/releases/tag/v0.3.0): ускоренная модель int8.** Видеокарты GeForce и серии RTX 30 переходят на квантование int8; на RTX 3090 создание 5-секундного видео стало быстрее примерно в 2.3 раза.
- **2026-10-06** · **Открыта [Галерея](https://freevideo-community.pages.dev/#gallery).** Смотрите 20-секундные ролики, созданные в FreeVideo, и наглядное сравнение всех четырех уровней качества.
- **2026-10-06** · **[v0.2.3](https://github.com/FlashML-org/FreeVideo/releases/tag/v0.2.3): видео сохраняют свой workflow.** Перетащите готовое видео FreeVideo на холст ComfyUI, чтобы мгновенно восстановить промпт, сид и все параметры генерации. Ранее созданные видео также поддерживаются.
- **2026-10-05** · **[v0.2.0](https://github.com/FlashML-org/FreeVideo/releases/tag/v0.2.0): четыре уровня качества.** Выбирайте Light, Medium, High или Max для каждого видео: высокие уровни дают максимальное качество, но требуют больше времени. Результаты можно экспортировать как изображения или видео для публикации с указанием времени генерации и модели GPU.
- **2026-10-05** · **[v0.1.2](https://github.com/FlashML-org/FreeVideo/releases/tag/v0.1.2): FreeVideo на Mac.** Компьютеры Mac на базе Apple Silicon теперь поддерживают локальную генерацию видео MiniMax H3 (предварительная версия).
- **2026-10-03** · **Пользовательские LoRA.** Используйте LoRA для MiniMax H3 прямо в рабочем процессе. См. [примеры](docs/LoRA.md).
- **2026-10-02** · **FreeVideo в открытом доступе.** Запуск MiniMax H3 на потребительских видеокартах всего от 8 ГБ VRAM.

## О проекте

FreeVideo — это локальный движок инференса для MiniMax H3 на потребительских видеокартах, созданный на базе 8-шаговой модели [VDN-H3](https://huggingface.co/OpenVDN/vdn-minimax-h3) от [OpenVDN](https://github.com/OpenVDN) с гибридным механизмом внимания [Video DeltaNet](https://openvdn.github.io/).

Он интеллектуально распределяет ресурсы видеопамяти (VRAM), оперативной памяти (RAM) и диска, адаптируя размещение весов, точность вычислений и ядра внимания под доступное оборудование. FreeVideo работает как плагин для ComfyUI и предоставляет удобные лаунчеры для Windows, macOS и Linux.

Основные возможности:

- **Аппаратно-адаптивное исполнение**: автоматически выбирает формат весов для каждого GPU (int8 для потребительских GeForce и серии RTX 30, FP8 для профессиональных карт и дата-центров) и на лету тестирует наиболее производительные ядра внимания.
- **Инференс с низким потреблением памяти**: потоковая загрузка весов (weight streaming), асинхронный префетчинг и блочные вычисления удерживают пиковое потребление памяти на минимальном уровне, позволяя работать всего с 8 ГБ VRAM и 16 ГБ RAM.
- **Мультимодальные входные данные**: текстовые описания (промпты), первый и последний кадры, а также референсные изображения, видео и аудио.
- **Поддержка LoRA сообщества**: подключение адаптеров LoRA для MiniMax H3 напрямую к генерации. См. [руководство](docs/LoRA.md).
- **Интеграция с ComfyUI**: выделенное творческое пространство в ComfyUI с поддержкой двухпроходного сэмплинга, пакетной генерации и сохранением истории проектов. Для тонкой настройки доступен стандартный режим узлов (node graph).
- **Установка в один клик**: готовые графические лаунчеры для Windows, Mac и Linux самостоятельно настраивают ComfyUI, среду Python и модели, подхватывают уже скачанные файлы и поддерживают офлайн-установку.

## Начало работы

### Windows

1. [Скачайте FreeVideoRU.exe](https://github.com/mrtek/FreeVideoRU/releases/latest/download/FreeVideoRU.exe) (или [FreeVideo.exe](https://github.com/FlashML-org/FreeVideo/releases/latest/download/FreeVideo.exe) с зеркала FlashML) и запустите.
2. Выберите существующую папку ComfyUI или настройте новую. Также можно указать путь к уже имеющимся папкам с моделями; недостающие файлы загрузятся автоматически.
3. Нажмите **Установить и запустить** (Install & launch). ComfyUI откроется в браузере с рабочей средой FreeVideo.

<div align="center">
  <img alt="Творческое пространство FreeVideo" src="https://github.com/user-attachments/assets/7647a6f8-4306-403c-b147-45d7a393e18d" width="92%">
</div>

**Офлайн-установка:** Скачайте пакеты с [Quark](https://pan.quark.cn/s/c51235b84618) и перетащите скачанные ZIP-файлы прямо в окно лаунчера без предварительной распаковки. Для полностью автономной установки требуются 4 пакета моделей (видеомодель, текстовый кодировщик, декодер видео и аудио, а также кэш сэмплинга), плюс архив среды выполнения для новой установки ComfyUI. Если импортировать только архив среды, для моделей можно выбрать **Автоматическое скачивание** (в версии v0.3.12 и новее). Кэш аудиореференсов опционален и требуется только в случае, если входной референс содержит аудиодорожку.

### macOS (предварительная версия для Apple silicon)

1. [Скачайте FreeVideo-Mac-arm64.dmg](https://github.com/FlashML-org/FreeVideo/releases/latest/download/FreeVideo-Mac-arm64.dmg), откройте образ и перетащите **FreeVideo.app** в папку **Программы** (Applications).
2. Запустите FreeVideo, выберите папку ComfyUI (или установите новую). Среда выполнения и недостающие модели будут загружены автоматически.
3. Нажмите **Установить и запустить**. ComfyUI откроется в браузере со средой FreeVideo.

Предварительная версия протестирована на Mac M5 с 24 ГБ объединенной памяти. См. [руководство для Mac](docs/Mac.md) с замерами времени генерации и потребления памяти.

*Примечание:* Сборка для Mac пока не нотариализована Apple, поэтому при первом открытии macOS может заблокировать запуск. Скачивайте сборку только из официальных релизов, после чего подтвердите запуск, как описано в [руководстве для Mac](docs/Mac.md#first-open).

### Существующий ComfyUI

Установите FreeVideo как кастомную ноду (custom node):

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/mrtek/FreeVideoRU.git
```

Перезапустите ComfyUI, перейдите в **Workflow → Browse Templates → FreeVideo → FreeVideo-All-in-One** и завершите начальную настройку в окне FreeVideo **Settings**.

### Linux

**Desktop:** [Скачайте FreeVideo-Linux-x86_64.AppImage](https://github.com/FlashML-org/FreeVideo/releases/latest/download/FreeVideo-Linux-x86_64.AppImage), сделайте файл исполняемым (`chmod +x FreeVideo-Linux-x86_64.AppImage`), запустите и следуйте инструкциям мастера настройки.

**Терминал или сервер:**

```bash
git clone https://github.com/mrtek/FreeVideoRU.git && cd FreeVideoRU
./setup.sh
```

Скрипт установит FreeVideo, ComfyUI и модели, а затем откроет интерфейс в браузере. Для последующего запуска используйте команду `freevideo`. На удаленном сервере подключитесь через SSH-туннель или запустите `freevideo server --listen 0.0.0.0` для доступа по локальной сети. Подробнее см. в [руководстве по Linux](docs/Linux.md).

### Дополнительно

- [Адаптивный планировщик выполнения FreeVideo](docs/execution-planning.md)
- [Результаты тестов сообщества](docs/community-results.md)

### Поддержка

Сообщайте об ошибках в [GitHub Issues](https://github.com/mrtek/FreeVideoRU/issues), либо в оригинальном репозитории [FlashML-org/FreeVideo](https://github.com/FlashML-org/FreeVideo/issues). Также присоединяйтесь к сообществу в [Discord](https://discord.gg/MsA277cJzZ), [QQ](https://freevideo-community.pages.dev/qq) или [WeChat](https://freevideo-community.pages.dev/wechat).

## Цитирование

FreeVideo базируется на архитектуре VDN-H3. Если вы используете FreeVideo в академических исследованиях, пожалуйста, процитируйте публикацию [Video DeltaNet](https://arxiv.org/abs/2609.20744):

```bibtex
@article{xi2026videodeltanet,
  title={Video DeltaNet: A Video-Native Hybrid Attention for Livestream Video Generation},
  author={Xi, Haocheng and Xie, Yiming and Zhao, Hexu and Zhang, Yiwen and Liu, Michael and Creavin, Thomas and Keutzer, Kurt and Li, Xiuyu and Lv, Zhaoyang and Xu, Chenfeng and Feng, Haiwen},
  journal={arXiv preprint arXiv:2609.20744},
  year={2026}
}
```

## Команда проекта

### Основная команда

[Bowen Xue](https://github.com/KBRASK) · [Shuo Yang](https://github.com/andy-yang-1) · [Haocheng Xi](https://github.com/haochengxi) · [Xiaoze Fan](https://github.com/jason-fxz) · [Chenfeng Xu](https://github.com/chenfengxu714)

### Особая благодарность

Особая благодарность [**AIwood爱屋研究室**](https://space.bilibili.com/503934057) и [**T8star-Aix**](https://space.bilibili.com/385085361) за всестороннее тестирование проекта и ценную обратную связь.

*Указаны в хронологическом порядке участия.*

## Благодарности

Мы благодарим команду [OpenVDN](https://github.com/OpenVDN) за проект [Video DeltaNet / VDN-H3](https://github.com/OpenVDN/vdn-minimax-h3), открытые веса модели, код обучения и алгоритмы инференса.

Благодарим Impossible Research за предоставленные вычислительные мощности.

Также выражаем признательность [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) за базовую модель и разработчикам следующих проектов:
[ComfyUI](https://github.com/Comfy-Org/ComfyUI),
[Diffusers](https://github.com/huggingface/diffusers),
[SageAttention](https://github.com/thu-ml/SageAttention),
[MiniMax H3 latent upscaler](https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler),
[H3 text encoder для ComfyUI](https://huggingface.co/t8star/Vdn-Minimax-H3-Comfy) и
[Qt for Python](https://doc.qt.io/qtforpython-6/).

## Лицензия

Исходный код распространяется под лицензией [Apache License 2.0](LICENSE). Веса моделей лицензированы согласно [MiniMax H3 Community License](https://huggingface.co/OpenVDN/vdn-minimax-h3-edge/blob/main/LICENSE), которая содержит региональные ограничения и правила допустимого использования.
