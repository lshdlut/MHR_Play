#ifndef MHR_MODEL_DATA_API_H
#define MHR_MODEL_DATA_API_H

#include <stdint.h>

#include "mhr_native_api.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct MhrModelCounts {
  uint32_t vertex_count;
  uint32_t face_count;
  uint32_t joint_count;
  uint32_t max_influence_count;
  uint32_t model_parameter_count;
  uint32_t identity_count;
  uint32_t expression_count;
  uint32_t parameter_input_count;
  uint32_t pose_feature_count;
  uint32_t hidden_count;
} MhrModelCounts;

typedef struct MhrSparseMatrixStats {
  uint32_t rows;
  uint32_t columns;
  uint64_t nnz;
  float exact_zero_fraction;
  uint32_t max_row_nnz;
  uint32_t max_column_nnz;
} MhrSparseMatrixStats;

typedef struct MhrPoseBlockLayout {
  uint32_t pose_block_count;
  uint32_t pose_feature_dim_per_joint;
  uint32_t hidden_dim_per_pose_block;
} MhrPoseBlockLayout;

typedef struct MhrDataWorkspaceCounts {
  uint32_t model_parameter_count;
  uint32_t identity_count;
  uint32_t expression_count;
  uint32_t joint_parameter_count;
  uint32_t local_transform_count;
  uint32_t global_transform_count;
  uint32_t skin_transform_count;
  uint32_t pose_feature_count;
  uint32_t hidden_count;
  uint32_t corrective_delta_count;
  uint32_t rest_pre_corrective_count;
  uint32_t rest_vertex_count;
  uint32_t output_vertex_count;
  uint32_t skeleton_count;
  uint32_t derived_count;
} MhrDataWorkspaceCounts;

typedef enum MhrForwardFlags {
  MHR_FORWARD_DEFAULT = 0,
  MHR_FORWARD_SKIP_DERIVED = 1 << 0,
} MhrForwardFlags;

typedef enum MhrStageDebugKind {
  MHR_STAGE_DEBUG_JOINT_PARAMETERS = 1,
  MHR_STAGE_DEBUG_LOCAL_SKELETON = 2,
  MHR_STAGE_DEBUG_GLOBAL_SKELETON = 3,
  MHR_STAGE_DEBUG_REST_SURFACE_PRE_CORRECTIVE = 4,
  MHR_STAGE_DEBUG_POSE_FEATURES = 5,
  MHR_STAGE_DEBUG_HIDDEN = 6,
  MHR_STAGE_DEBUG_CORRECTIVE_DELTA = 7,
  MHR_STAGE_DEBUG_REST_SURFACE_POST_CORRECTIVE = 8,
  MHR_STAGE_DEBUG_SKIN_JOINT_STATES = 9,
  MHR_STAGE_DEBUG_FINAL_VERTICES = 10,
  MHR_STAGE_DEBUG_REST_VERTICES = MHR_STAGE_DEBUG_REST_SURFACE_POST_CORRECTIVE,
} MhrStageDebugKind;

typedef struct MhrModel MhrModel;
typedef struct MhrData MhrData;

MHR_NATIVE_EXPORT MhrModel* mhr_model_load_ir(const MhrBundleView* bundle_view);
MHR_NATIVE_EXPORT void mhr_model_destroy(MhrModel* model);
MHR_NATIVE_EXPORT const char* mhr_model_last_error(const MhrModel* model);
MHR_NATIVE_EXPORT int mhr_model_get_counts(const MhrModel* model, MhrModelCounts* counts);
MHR_NATIVE_EXPORT int mhr_model_get_parameter_transform_stats(
    const MhrModel* model,
    MhrSparseMatrixStats* stats);
MHR_NATIVE_EXPORT int mhr_model_get_pose_corrective_stats(
    const MhrModel* model,
    MhrSparseMatrixStats* stage1_stats,
    MhrSparseMatrixStats* stage2_stats);
MHR_NATIVE_EXPORT int mhr_model_get_pose_block_layout(
    const MhrModel* model,
    MhrPoseBlockLayout* layout);

MHR_NATIVE_EXPORT MhrData* mhr_data_create(const MhrModel* model);
MHR_NATIVE_EXPORT void mhr_data_destroy(MhrData* data);
MHR_NATIVE_EXPORT const char* mhr_data_last_error(const MhrData* data);
MHR_NATIVE_EXPORT int mhr_data_reset(const MhrModel* model, MhrData* data);
MHR_NATIVE_EXPORT int mhr_data_get_workspace_counts(
    const MhrData* data,
    MhrDataWorkspaceCounts* counts);
MHR_NATIVE_EXPORT int mhr_data_set_model_parameters(
    const MhrModel* model,
    MhrData* data,
    const float* values,
    uint32_t count);
MHR_NATIVE_EXPORT int mhr_data_set_identity(
    const MhrModel* model,
    MhrData* data,
    const float* values,
    uint32_t count);
MHR_NATIVE_EXPORT int mhr_data_set_expression(
    const MhrModel* model,
    MhrData* data,
    const float* values,
    uint32_t count);
MHR_NATIVE_EXPORT int mhr_forward(const MhrModel* model, MhrData* data, uint32_t flags);
MHR_NATIVE_EXPORT int mhr_get_debug_timing(
    const MhrData* data,
    MhrRuntimeDebugTiming* timing);
MHR_NATIVE_EXPORT int mhr_get_stage_debug(
    const MhrModel* model,
    const MhrData* data,
    uint32_t stage_kind,
    float* out_values,
    uint32_t count);
MHR_NATIVE_EXPORT int mhr_get_vertices(
    const MhrModel* model,
    const MhrData* data,
    float* out_values,
    uint32_t count);
MHR_NATIVE_EXPORT int mhr_get_skeleton(
    const MhrModel* model,
    const MhrData* data,
    float* out_values,
    uint32_t count);
MHR_NATIVE_EXPORT int mhr_get_derived(
    const MhrModel* model,
    const MhrData* data,
    float* out_values,
    uint32_t count);

#ifdef __cplusplus
}
#endif

#endif
