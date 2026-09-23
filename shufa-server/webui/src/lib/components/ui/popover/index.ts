import { Popover as PopoverPrimitive } from "bits-ui";
import Content from "./popover-content.svelte";

/** shadcn-svelte popover（bits-ui 封装；Root/Trigger/Close 直通原语）。 */
const Root = PopoverPrimitive.Root;
const Trigger = PopoverPrimitive.Trigger;
const Close = PopoverPrimitive.Close;

export {
	Root,
	Trigger,
	Content,
	Close,
	//
	Root as Popover,
	Trigger as PopoverTrigger,
	Content as PopoverContent,
	Close as PopoverClose,
};
