<script lang="ts">
	import { Popover as PopoverPrimitive } from "bits-ui";
	import type { Snippet } from "svelte";
	import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";

	let {
		ref = $bindable(null),
		class: className,
		sideOffset = 4,
		align = "end",
		children,
		...restProps
	}: WithoutChildrenOrChild<PopoverPrimitive.ContentProps> & {
		children: Snippet;
		sideOffset?: number;
		align?: "start" | "center" | "end";
	} = $props();
</script>

<PopoverPrimitive.Content
	bind:ref
	{sideOffset}
	{align}
	data-slot="popover-content"
	class={cn(
		"bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 ring-foreground/10 rounded-xl p-1 text-sm shadow-md ring-1 duration-100 z-50 w-72 outline-none",
		className
	)}
	{...restProps}
>
	{@render children?.()}
</PopoverPrimitive.Content>
