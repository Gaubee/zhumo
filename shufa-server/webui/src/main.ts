/**
 * SPA 入口：挂载 App（mock 层驱动，见 lib/api.ts 切换点）。
 * 正交意图：[1] mount + 全局样式注入。
 */
import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";

const target = document.getElementById("app");
if (target === null) throw new Error("缺少 #app 挂载点");

mount(App, { target });
