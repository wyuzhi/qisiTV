import CharacterCount from "@tiptap/extension-character-count";
import Color from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import StarterKit from "@tiptap/starter-kit";

// Keep heavy Tiptap editor extensions isolated from read-only canvas node rendering.
export function createCanvasRichTextExtensions(placeholder?: string) {
    return [
        StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        TextStyle,
        Color.configure({ types: ["textStyle"] }),
        Highlight.configure({ multicolor: true }),
        CharacterCount,
        ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    ];
}
