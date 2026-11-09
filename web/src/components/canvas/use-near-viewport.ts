import { useEffect, useState, type RefObject } from "react";

export function useNearViewport(ref: RefObject<Element | null>) {
    const [nearViewport, setNearViewport] = useState(false);
    useEffect(() => {
        const element = ref.current;
        if (!element || typeof IntersectionObserver === "undefined") {
            setNearViewport(true);
            return;
        }
        let zoomWaitTimer: ReturnType<typeof setTimeout> | null = null;
        const observer = new IntersectionObserver((entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            if (element.closest('[data-canvas-viewport-zooming="true"]')) {
                if (!zoomWaitTimer) {
                    const retryWhenZoomIdle = () => {
                        zoomWaitTimer = null;
                        if (!element.isConnected) return;
                        if (element.closest('[data-canvas-viewport-zooming="true"]')) {
                            zoomWaitTimer = setTimeout(retryWhenZoomIdle, 80);
                            return;
                        }
                        observer.unobserve(element);
                        observer.observe(element);
                    };
                    zoomWaitTimer = setTimeout(retryWhenZoomIdle, 80);
                }
                return;
            }
            setNearViewport(true);
            observer.disconnect();
        }, { rootMargin: "600px" });
        observer.observe(element);
        return () => {
            if (zoomWaitTimer) clearTimeout(zoomWaitTimer);
            observer.disconnect();
        };
    }, [ref]);
    return nearViewport;
}
