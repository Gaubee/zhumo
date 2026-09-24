/**
 * §4 API 契约 barrel。
 * 原始需求 2026-09-23（PRODUCT_DESIGN.md §4 路由与权限矩阵）。
 * 正交意图：聚合各域契约为单一入口（daemon/webui 只 import '@zhumo/contracts'）。
 */
export * from './auth.js';
export * from './setup.js';
export * from './admin.js';
export * from './models.js';
export * from './tasks.js';
export * from './resources.js';
export * from './kb.js';
