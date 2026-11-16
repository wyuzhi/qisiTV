import { App } from "antd";
import copy from "copy-to-clipboard";

export function useCopyText() {
    const { message } = App.useApp();

    return (value: string, successText = "已复制") => {
        void Promise.resolve(copy(value))
            .then((copied) => {
                if (copied) {
                    message.success(successText);
                } else {
                    message.error("复制失败，请手动选中复制");
                }
            })
            .catch(() => {
                message.error("复制失败，请手动选中复制");
            });
    };
}
