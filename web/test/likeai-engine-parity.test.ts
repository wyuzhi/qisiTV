import { expect, test } from "bun:test";
import { apiClient } from "../src/services/api/request";
import { createModelChannel, defaultConfig, likeAIWorkspaceConfig, resolveModelRequestConfig, modelOptionsFromChannels } from "../src/stores/use-config-store";
import { serviceModelProfile, modelCatalogRequestURL } from "../src/lib/model-service-presets";
import { defaultModelCapabilityConfig } from "../src/lib/model-capabilities";
import { estimateUpscale } from "../src/services/api/media-upscale";
import { createDefaultUpscaleSettings, upscaleParamsForNode } from "../src/lib/canvas/canvas-upscale";
import { isAIUpscaleTask } from "../src/lib/canvas/canvas-ai-upscale-task";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import type { ModelProtocolDefinition } from "../src/lib/model-protocols";

test("preferred media channels preserve the assistant protocol and independent credentials", () => {
    const assistant = createModelChannel({ id:"assistant", baseUrl:"https://llm.example/v1", apiFormat:"claude", apiKey:"assistant-fixture", models:["text-model"], modelProfiles:[{model:"text-model", capability:"text", protocol:"claude-api"}] });
    const official = createModelChannel({id:"likeai", apiFormat:"likeai", apiKey:"media-fixture", models:["wan_video_3_prime"], modelProfiles:[{model:"wan_video_3_prime", capability:"video", protocol:"likeai-video"}]});
    const config = likeAIWorkspaceConfig({...defaultConfig, channels:[assistant,official], assistantModel:"assistant::text-model", textModel:"assistant::text-model"});
    expect(config.channels.find(c=>c.id==="assistant")).toMatchObject(assistant);
    expect(config.assistantModel).toBe("assistant::text-model");
    expect(resolveModelRequestConfig(config,"assistant::text-model")).toMatchObject({apiFormat:"claude",interfaceType:"claude-api",apiKey:"assistant-fixture"});
    expect(resolveModelRequestConfig(config,"likeai::wan_video_3_prime")).toMatchObject({apiFormat:"likeai",interfaceType:"likeai-video",apiKey:"media-fixture"});
    expect(config.channels.some(c=>c.id==="beefapi")).toBe(false);
    expect(config.channels.find(c=>c.id==="qisi-api")?.apiKey).toBe("");
});

test("LikeAI catalog and documented model defaults use their own protocol", () => {
    const channel=createModelChannel({apiFormat:"likeai",models:[]});
    expect(modelCatalogRequestURL(channel)).toBe("https://task.likeai.pro/task-api/task/models");
    expect(serviceModelProfile(channel,{id:"wan_video_3_prime",modelType:"video"},[{value:"likeai-video",capability:"video",enabled:true} as ModelProtocolDefinition])).toMatchObject({protocol:"likeai-video"});
    const prime=defaultModelCapabilityConfig("likeai-video","wan_video_3_prime").video!;
    expect(prime.duration.values).toContain(-1);
    expect(prime.references.maxVideos).toBe(5);
    expect(defaultModelCapabilityConfig("likeai-image","doubao_seedream_4_5").image?.quality.default).toBe("1440p");
});

test("LikeAI upscale does not inherit Topaz scale or expose a generation model", () => {
    const settings=createDefaultUpscaleSettings("official-likeai");
    settings.image={mode:"likeai",model:"huoshan_image_super_resolution",outputFormat:"",modelQuality:"HQ"};
    settings.video={mode:"likeai",model:"tengxun_video_super_resolution",resolution:"2160p"};
    const image={type:CanvasNodeType.Image} as CanvasNodeData;
    expect(upscaleParamsForNode(settings,image,"owned")).toEqual({resourceId:"owned",channelId:"official-likeai",mode:"likeai",model:"huoshan_image_super_resolution",scale:1,modelQuality:"HQ"});
    expect(upscaleParamsForNode(settings,{...image,type:CanvasNodeType.Video},"owned")).toMatchObject({resolution:"2160p",scale:1});
    expect(modelOptionsFromChannels([createModelChannel({id:"likeai",models:[settings.image.model,settings.video.model,"normal"]})])).toEqual(["likeai::normal"]);
    expect(isAIUpscaleTask({type:"canvas_image",model:settings.image.model})).toBe(true);
    expect(isAIUpscaleTask({type:"canvas_video",model:settings.image.model})).toBe(false);
});

test("unknown LikeAI pricing is explicit and cannot bypass Topaz quote validation",async()=>{
    const original=apiClient.request;
    const calls:string[]=[];
    apiClient.request=(async req=>{calls.push(req.url!);return{status:200,data:{code:0,data:{provider:"likeai",priceKnown:false,reservation:0,generationSubmitted:false,currency:"CNY"}}};}) as typeof apiClient.request;
    const params={resourceId:"owned",channelId:"likeai",mode:"likeai" as const,model:"huoshan_image_super_resolution",scale:1,modelQuality:"MQ" as const};
    try{
        expect((await estimateUpscale(params)).priceKnown).toBe(false);
        await expect(estimateUpscale({...params,mode:"precision",channelId:"beefapi",model:"Standard V2"})).rejects.toThrow("费用");
        expect(calls).toEqual(["/media-upscale/estimate","/media-upscale/estimate"]);
    }finally{apiClient.request=original;}
});
