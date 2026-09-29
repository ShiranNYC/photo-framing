# Third-party model: YuNet face detector

`faces/models/face_detection_yunet_2023mar.onnx` (sha256
`8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`, checked by
`scripts/detect-faces.py` before every run) is the YuNet face detection model from the
[OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet),
originally from [ShiqiYu/libfacedetection.train](https://github.com/ShiqiYu/libfacedetection.train).

License: **MIT** (Copyright (c) 2020 Shiqi Yu). No conflict with this package's own MIT
license. Full text: [`LICENSE-yunet-model.txt`](./LICENSE-yunet-model.txt), fetched verbatim
from `opencv_zoo/models/face_detection_yunet/LICENSE`.

Detection with this model runs entirely offline (see `scripts/detect-faces.py`'s module
docstring): no photo is ever sent to any external service. Images are only ever read from
disk or downloaded, read-only, from a URL you configure (`media.remoteOrigin`).
