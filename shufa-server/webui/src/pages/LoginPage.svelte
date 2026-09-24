<!--
  /login 登录页（PRODUCT_DESIGN §3：未认证且匿名关闭 → Dialog 登录；匿名开时
  由 App 自动匿名，不进本页）。Dialog 语法渲染在居中遮罩上。
  正交意图：[1] 用户名+密码登录表单（错误中文）。
-->
<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { login } from "$lib/stores/auth.svelte";
  import { navigate } from "$lib/router.svelte";

  let username = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(): Promise<void> {
    busy = true;
    error = null;
    const ok = await login(username.trim(), password);
    busy = false;
    if (ok) navigate("#/");
  }
</script>

<div class="flex min-h-screen items-center justify-center bg-paper px-4">
  <Dialog.Root open={true}>
    <Dialog.Content class="max-w-sm p-6">
      <Dialog.Header class="gap-1">
        <Dialog.Title class="flex items-center gap-2 text-base">
          <img src="/icon.svg" alt="朱墨" class="size-6 rounded-[4px]" />
          登录朱墨
        </Dialog.Title>
        <Dialog.Description class="text-xs">使用管理员或成员账号继续</Dialog.Description>
      </Dialog.Header>
      <form
        class="mt-2 flex flex-col gap-3"
        onsubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">用户名</span>
          <Input bind:value={username} autocomplete="username" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span class="text-muted-foreground">密码</span>
          <Input bind:value={password} type="password" autocomplete="current-password" />
        </label>
        {#if error}
          <p class="text-xs text-destructive" role="alert">{error}</p>
        {/if}
        <Button type="submit" disabled={busy}>{busy ? "登录中…" : "登录"}</Button>
      </form>
    </Dialog.Content>
  </Dialog.Root>
</div>
