/**
 * @zhumo/contracts 入口：daemon 与 webui 共享的全部线格式。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md，W2' 第一优先交付）。
 * 正交意图：barrel 聚合（帧模型 / 结果页数据 / 全路由请求响应契约）。
 */
export * from './common.js';
export * from './frame.js';
export * from './analysis.js';
export * from './api/index.js';
