# QuizLive – Quiz realtime kiểu Kahoot

## Chạy
```bash
npm install
npm start                       # mật khẩu admin mặc định: admin123
ADMIN_PASSWORD=matkhau npm start   # đổi mật khẩu
```
- Admin: http://localhost:3000/admin
- Người chơi: http://localhost:3000 (cùng mạng LAN thì dùng IP máy host, vd `http://192.168.1.10:3000`)

## Luồng chơi
1. Admin đăng nhập → tạo quiz (câu hỏi, 2–4 đáp án, ảnh, thời gian 5–120s) → Lưu.
2. Bấm **Host game** → hiện mã PIN 6 số.
3. Người chơi vào trang chủ, nhập PIN + biệt danh.
4. Admin bấm **Bắt đầu**. Mỗi câu: 3s chuẩn bị → đếm ngược → kết quả + bảng điểm.
5. Hết game: bục vinh danh Top 5; mỗi người chơi thấy hạng của mình.

## Tính điểm (giống Kahoot)
Trả lời đúng: `điểm = round(1000 × (1 − (thời gian trả lời / thời gian câu hỏi) / 2))`
→ trả lời ngay ≈ 1000 điểm, sát giờ ≈ 500 điểm. Sai hoặc không trả lời: 0.
Thời gian được đo trên server nên công bằng giữa các thiết bị.

## Cấu trúc
- `server.js` – Express + Socket.io, API quiz, logic game
- `public/admin.html` – quản lý quiz + màn hình host
- `public/index.html` – màn hình người chơi (tối ưu mobile)
- `data/quizzes.json` – nơi lưu quiz (ảnh lưu dạng base64, tự resize ≤1200px)
