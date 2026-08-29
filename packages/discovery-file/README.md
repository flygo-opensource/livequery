# @livequery/discovery-file

Publisher ghi một JSON manifest cho mỗi service instance vào shared directory.
Phù hợp khi application service và Nginx/Kong agent nhìn thấy cùng filesystem.

## Cài đặt

```sh
bun add @livequery/discovery-file @livequery/service
```

## Sử dụng

```ts
import { FileServicePublisher } from '@livequery/discovery-file'

const publisher = new FileServicePublisher({
  directory: '/var/run/livequery/services',
})
```

Tên file có dạng:

```text
orders-orders-a.json
orders-orders-b.json
```

File được ghi vào temporary path rồi atomic rename sang target. `close()` xóa
manifest của instance và bỏ qua lỗi `ENOENT`.

Package này chỉ làm nhiệm vụ publish. Agent-side watcher, validation, render
config và safe reload được đặt ngoài application process.
