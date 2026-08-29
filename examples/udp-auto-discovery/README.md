# UDP API auto-discovery E2E

Ví dụ chạy API service và API gateway ở hai process độc lập, dùng trực tiếp
`@ohayo/udp`. Không có route registry tĩnh và không gọi `gateway.register()`.

Hai kịch bản E2E được kiểm tra:

1. Service chạy trước, phát hiện gateway khởi động muộn rồi tự công bố lại API.
2. Gateway chạy trước, phát hiện service khởi động muộn và tự thêm route.

Trong cả hai trường hợp, request `GET /livequery/catalog` qua gateway phải được
forward tới đúng process service.

Chạy từ workspace root:

```sh
bun run --cwd examples test
```

Các biến môi trường chính là `OHAYO_DISCOVERY_NAMESPACE`,
`OHAYO_DISCOVERY_KEY`, `OHAYO_DISCOVERY_PORT` và `OHAYO_SERVICE_HOST`. E2E tự
tạo namespace, key và UDP port riêng cho từng test.

Hiện `@ohayo/udp` chưa có trên npm; workspace root override phiên bản `^3.0.0`
sang source local `../ohayo/udp`. Khi phát hành độc lập cần publish Ohayo trước.
