import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * Điểm khởi động app web.
 *
 * Ranh giới (ARCHITECTURE.md §2): `apps/web` CHỈ được import `@app/shared`.
 * KHÔNG được import `@app/engine`, `@app/db`, `@app/jira` — chúng chạy trên
 * máy chủ, kéo vào đây là gói tải về phình lên và lộ chi tiết bên trong.
 *
 * `apps/web/src/api/` là nơi DUY NHẤT được gọi `fetch`.
 */

const rootElement = document.getElementById('root');

if (rootElement === null) {
  // Không im lặng: thiếu `<div id="root">` thì app không mount, màn hình trắng
  // trơn, và console cũng không có gì để lần.
  throw new Error('No #root element in index.html — the app cannot start.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
