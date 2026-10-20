"""CPU SAM 2.1 Hiera small; one pixel-hashed image encoding per worker."""
import hashlib
import math


# Bound full-resolution candidate logits as well as image decompression.
MAX_PIXELS = 4096 * 4096
MAX_POINTS = 16


def validate_points(points, size=None):
    if not isinstance(points, list) or not 1 <= len(points) <= MAX_POINTS:
        raise ValueError('invalid_points')
    for point in points:
        if (not isinstance(point, (list, tuple)) or len(point) != 3
                or any(type(v) not in (int, float) or type(v) is float and not math.isfinite(v)
                       for v in point[:2])
                or type(point[2]) is not int or point[2] not in (0, 1)
                or any(not 0 <= v < MAX_PIXELS for v in point[:2])
                or size is not None and (point[0] >= size[0] or point[1] >= size[1])):
            raise ValueError('invalid_points')
    if not any(p[2] for p in points):
        raise ValueError('invalid_points')


def load_image(path):
    from PIL import Image
    try:
        with Image.open(path) as image:
            if image.width * image.height > MAX_PIXELS:
                raise ValueError('invalid_media')
            # Match region_edit: coordinates and output dimensions are stored pixels.
            return image.convert('RGB')
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise ValueError('invalid_media') from error


def build_model(checkpoint):
    """Literal upstream sam2.1_hiera_s config, without Hydra or iopath."""
    import torch
    from ..sam2.modeling.backbones.hieradet import Hiera
    from ..sam2.modeling.backbones.image_encoder import ImageEncoder, FpnNeck
    from ..sam2.modeling.position_encoding import PositionEmbeddingSine
    from ..sam2.modeling.memory_attention import MemoryAttention, MemoryAttentionLayer
    from ..sam2.modeling.memory_encoder import MemoryEncoder, MaskDownSampler, Fuser, CXBlock
    from ..sam2.modeling.sam.transformer import RoPEAttention
    from ..sam2.modeling.sam2_base import SAM2Base

    model = SAM2Base(
        image_encoder=ImageEncoder(scalp=1,
            trunk=Hiera(embed_dim=96, num_heads=1, stages=[1, 2, 11, 2],
                        global_att_blocks=[7, 10, 13], window_pos_embed_bkg_spatial_size=[7, 7]),
            neck=FpnNeck(position_encoding=PositionEmbeddingSine(256, normalize=True, temperature=10000, warmup_cache=False),
                         d_model=256, backbone_channel_list=[768, 384, 192, 96],
                         fpn_top_down_levels=[2, 3], fpn_interp_model='nearest')),
        memory_attention=MemoryAttention(d_model=256, pos_enc_at_input=True, num_layers=4,
            layer=MemoryAttentionLayer(activation='relu', dim_feedforward=2048, dropout=.1,
                pos_enc_at_attn=False, d_model=256, pos_enc_at_cross_attn_keys=True,
                pos_enc_at_cross_attn_queries=False,
                self_attention=RoPEAttention(rope_theta=10000., feat_sizes=[64, 64],
                    embedding_dim=256, num_heads=1, downsample_rate=1, dropout=.1),
                cross_attention=RoPEAttention(rope_theta=10000., feat_sizes=[64, 64], rope_k_repeat=True,
                    embedding_dim=256, num_heads=1, downsample_rate=1, dropout=.1, kv_in_dim=64))),
        memory_encoder=MemoryEncoder(out_dim=64,
            position_encoding=PositionEmbeddingSine(64, normalize=True, temperature=10000, warmup_cache=False),
            mask_downsampler=MaskDownSampler(kernel_size=3, stride=2, padding=1),
            fuser=Fuser(layer=CXBlock(dim=256, kernel_size=7, padding=3,
                        layer_scale_init_value=1e-6, use_dwconv=True), num_layers=2)),
        num_maskmem=7, image_size=1024, sigmoid_scale_for_mem_enc=20., sigmoid_bias_for_mem_enc=-10.,
        use_mask_input_as_output_without_sam=True, directly_add_no_mem_embed=True,
        no_obj_embed_spatial=True, use_high_res_features_in_sam=True, multimask_output_in_sam=True,
        iou_prediction_use_sigmoid=True, use_obj_ptrs_in_encoder=True, add_tpos_enc_to_obj_ptrs=True,
        proj_tpos_enc_in_obj_ptrs=True, use_signed_tpos_enc_to_obj_ptrs=True,
        only_obj_ptrs_in_the_past_for_eval=True, pred_obj_scores=True, pred_obj_scores_mlp=True,
        fixed_no_obj_ptr=True, multimask_output_for_tracking=True, use_multimask_token_for_obj_ptr=True,
        multimask_min_pt_num=0, multimask_max_pt_num=1, use_mlp_for_obj_ptr_proj=True,
        compile_image_encoder=False)
    state = torch.load(checkpoint, map_location='cpu', weights_only=True)
    model.load_state_dict(state['model'], strict=True)
    return model.cpu().eval()


class Segmenter:
    def __init__(self, checkpoint):
        import torch
        from ..sam2.sam2_image_predictor import SAM2ImagePredictor
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        self.predictor = SAM2ImagePredictor(build_model(checkpoint), max_hole_area=0, max_sprinkle_area=0)
        self.key = None
        self.encode_count = 0

    def segment(self, image, points):
        import numpy as np
        import torch
        from PIL import Image
        validate_points(points, image.size)
        image = image.convert('RGB')
        key = image.size, hashlib.sha256(image.tobytes()).digest()
        # The reference adapter groups positive points before negative points.
        ordered = [p for p in points if p[2]] + [p for p in points if not p[2]]
        with torch.inference_mode():
            if key != self.key:
                self.clear_image()
                self.predictor.set_image(np.asarray(image))
                self.key = key
                self.encode_count += 1
            masks, scores, _ = self.predictor.predict(
                point_coords=np.asarray([p[:2] for p in ordered], dtype=np.float32),
                point_labels=np.asarray([p[2] for p in ordered], dtype=np.int32),
                multimask_output=True)
            return Image.fromarray(masks[int(np.argmax(scores))].astype(bool).astype(np.uint8) * 255)

    def clear_image(self):
        self.key = None
        self.predictor.reset_predictor()
