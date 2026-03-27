#include "mhr_runtime.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <sstream>
#include <string_view>

namespace mhr {
namespace {

constexpr uint32_t kOfficialIdentityCount = 45;
constexpr uint32_t kDerivedValueCount = 7;

struct Vec3 final {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Vec3f final {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;
};

struct Quat final {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double w = 1.0;
};

struct Quatf final {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;
  float w = 1.0f;
};

struct Transform final {
  Vec3 translation;
  Quat rotation;
  double scale = 1.0;
};

struct Transformf final {
  Vec3f translation;
  Quatf rotation;
  float scale = 1.0f;
};

Vec3 add_vec(const Vec3& a, const Vec3& b) {
  return Vec3{a.x + b.x, a.y + b.y, a.z + b.z};
}

Vec3 scale_vec(const Vec3& value, const double scale) {
  return Vec3{value.x * scale, value.y * scale, value.z * scale};
}

Vec3 cross_vec(const Vec3& a, const Vec3& b) {
  return Vec3{
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x,
  };
}

Vec3f add_vecf(const Vec3f& a, const Vec3f& b) {
  return Vec3f{a.x + b.x, a.y + b.y, a.z + b.z};
}

Vec3f scale_vecf(const Vec3f& value, const float scale) {
  return Vec3f{value.x * scale, value.y * scale, value.z * scale};
}

Vec3f cross_vecf(const Vec3f& a, const Vec3f& b) {
  return Vec3f{
      a.y * b.z - a.z * b.y,
      a.z * b.x - a.x * b.z,
      a.x * b.y - a.y * b.x,
  };
}

bool is_required_key(std::string_view key) {
  static constexpr std::string_view kRequiredKeys[] = {
      "meshTopology",
      "skinningWeights",
      "skinningIndices",
      "bindMatrices",
      "inverseBindMatrices",
      "rigTransforms",
      "jointParents",
      "parameterTransform",
      "parameterLimits",
      "parameterMaskPose",
      "parameterMaskRigid",
      "parameterMaskScaling",
      "blendshapeData",
      "correctiveData",
      "correctiveSparseIndices",
      "correctiveSparseWeights",
  };
  for (const std::string_view candidate : kRequiredKeys) {
    if (candidate == key) {
      return true;
    }
  }
  return false;
}

uint64_t shape_element_count(const BundleArray& array) {
  if (array.shape.empty()) {
    return 0;
  }
  uint64_t result = 1;
  for (const uint64_t dim : array.shape) {
    result *= dim;
  }
  return result;
}

size_t scalar_type_size(MhrScalarType scalar_type) {
  switch (scalar_type) {
    case MHR_SCALAR_FLOAT32:
      return sizeof(float);
    case MHR_SCALAR_UINT32:
      return sizeof(uint32_t);
    case MHR_SCALAR_INT32:
      return sizeof(int32_t);
    case MHR_SCALAR_INT64:
      return sizeof(int64_t);
    case MHR_SCALAR_UINT8:
      return sizeof(uint8_t);
  }
  return 0;
}

template <typename T>
const T* array_data(const BundleArray& array) {
  return static_cast<const T*>(array.data);
}

Quat normalize_quat(const Quat& q) {
  const double norm =
      std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (norm <= std::numeric_limits<double>::epsilon()) {
    return Quat{};
  }
  const double inv = 1.0 / norm;
  return Quat{q.x * inv, q.y * inv, q.z * inv, q.w * inv};
}

Quat quat_multiply_assume_normalized(const Quat& a, const Quat& b) {
  return Quat{
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

Quatf normalize_quatf(const Quatf& q) {
  float norm_sq = q.x * q.x;
  norm_sq += q.y * q.y;
  norm_sq += q.z * q.z;
  norm_sq += q.w * q.w;
  const float norm = std::sqrt(norm_sq);
  if (norm <= std::numeric_limits<float>::epsilon()) {
    return Quatf{};
  }
  return Quatf{q.x / norm, q.y / norm, q.z / norm, q.w / norm};
}

Quatf quat_multiply_assume_normalizedf(const Quatf& a, const Quatf& b) {
  return Quatf{
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

Vec3 rotate_vec_assume_normalized(const Quat& q, const Vec3& v) {
  const Vec3 axis{q.x, q.y, q.z};
  const Vec3 av = cross_vec(axis, v);
  const Vec3 aav = cross_vec(axis, av);
  return add_vec(v, scale_vec(add_vec(scale_vec(av, q.w), aav), 2.0));
}

Vec3f rotate_vec_assume_normalizedf(const Quatf& q, const Vec3f& v) {
  const Vec3f axis{q.x, q.y, q.z};

  Vec3f av;
  av.x = axis.y * v.z;
  av.x -= axis.z * v.y;
  av.y = axis.z * v.x;
  av.y -= axis.x * v.z;
  av.z = axis.x * v.y;
  av.z -= axis.y * v.x;

  Vec3f aav;
  aav.x = axis.y * av.z;
  aav.x -= axis.z * av.y;
  aav.y = axis.z * av.x;
  aav.y -= axis.x * av.z;
  aav.z = axis.x * av.y;
  aav.z -= axis.y * av.x;

  Vec3f result = v;
  result.x += 2.0f * (av.x * q.w + aav.x);
  result.y += 2.0f * (av.y * q.w + aav.y);
  result.z += 2.0f * (av.z * q.w + aav.z);
  return result;
}

Quatf euler_xyz_quatf(float rx, float ry, float rz) {
  const float cy = std::cos(rz * 0.5f);
  const float sy = std::sin(rz * 0.5f);
  const float cp = std::cos(ry * 0.5f);
  const float sp = std::sin(ry * 0.5f);
  const float cr = std::cos(rx * 0.5f);
  const float sr = std::sin(rx * 0.5f);
  return Quatf{
      sr * cp * cy - cr * sp * sy,
      cr * sp * cy + sr * cp * sy,
      cr * cp * sy - sr * sp * cy,
      cr * cp * cy + sr * sp * sy,
  };
}

Transform multiply_skel_state(const Transform& parent, const Transform& local) {
  const Quat parent_rotation = normalize_quat(parent.rotation);
  const Quat local_rotation = normalize_quat(local.rotation);
  const Vec3 rotated = rotate_vec_assume_normalized(parent_rotation, local.translation);
  return Transform{
      Vec3{
          parent.translation.x + rotated.x * parent.scale,
          parent.translation.y + rotated.y * parent.scale,
          parent.translation.z + rotated.z * parent.scale,
      },
      quat_multiply_assume_normalized(parent_rotation, local_rotation),
      parent.scale * local.scale,
  };
}

Vec3 apply_point_transform(const Transform& transform, const Vec3& point) {
  const Quat rotation = normalize_quat(normalize_quat(transform.rotation));
  const Vec3 rotated = rotate_vec_assume_normalized(rotation, scale_vec(point, transform.scale));
  return Vec3{
      transform.translation.x + rotated.x,
      transform.translation.y + rotated.y,
      transform.translation.z + rotated.z,
  };
}

Transformf multiply_skel_statef(const Transformf& parent, const Transformf& local) {
  const Quatf parent_rotation = normalize_quatf(parent.rotation);
  const Quatf local_rotation = normalize_quatf(local.rotation);
  const Vec3f rotated = rotate_vec_assume_normalizedf(parent_rotation, local.translation);
  return Transformf{
      Vec3f{
          parent.translation.x + rotated.x * parent.scale,
          parent.translation.y + rotated.y * parent.scale,
          parent.translation.z + rotated.z * parent.scale,
      },
      quat_multiply_assume_normalizedf(parent_rotation, local_rotation),
      parent.scale * local.scale,
  };
}

Vec3f apply_point_transformf(const Transformf& transform, const Vec3f& point) {
  const Quatf rotation = normalize_quatf(normalize_quatf(transform.rotation));
  const Vec3f rotated =
      rotate_vec_assume_normalizedf(rotation, scale_vecf(point, transform.scale));
  return Vec3f{
      transform.translation.x + rotated.x,
      transform.translation.y + rotated.y,
      transform.translation.z + rotated.z,
  };
}

Transform tuple_transform(const float* values) {
  return Transform{
      Vec3{values[0], values[1], values[2]},
      Quat{values[3], values[4], values[5], values[6]},
      values[7],
  };
}

Transformf tuple_transformf(const float* values) {
  return Transformf{
      Vec3f{values[0], values[1], values[2]},
      Quatf{values[3], values[4], values[5], values[6]},
      values[7],
  };
}

void write_transform_tuple(const Transform& transform, float* out_values) {
  out_values[0] = static_cast<float>(transform.translation.x);
  out_values[1] = static_cast<float>(transform.translation.y);
  out_values[2] = static_cast<float>(transform.translation.z);
  out_values[3] = static_cast<float>(transform.rotation.x);
  out_values[4] = static_cast<float>(transform.rotation.y);
  out_values[5] = static_cast<float>(transform.rotation.z);
  out_values[6] = static_cast<float>(transform.rotation.w);
  out_values[7] = static_cast<float>(transform.scale);
}

}  // namespace

bool Runtime::set_error(const std::string& message) {
  last_error_ = message;
  return false;
}

bool Runtime::require_bundle_loaded() const { return bundle_loaded_; }

bool Runtime::load_array(const MhrArrayView& view) {
  if (view.key == nullptr || view.data == nullptr) {
    return set_error("Bundle array view must provide key and data.");
  }
  if (view.rank == 0 || view.shape == nullptr) {
    return set_error("Bundle array view must provide rank and shape.");
  }
  BundleArray array;
  array.scalar_type = view.scalar_type;
  array.data = view.data;
  array.byte_length = view.byte_length;
  array.shape.assign(view.shape, view.shape + view.rank);
  const size_t element_size = scalar_type_size(view.scalar_type);
  if (element_size == 0) {
    return set_error("Unknown scalar type in bundle array view.");
  }
  const uint64_t element_count = shape_element_count(array);
  if (element_count == 0) {
    return set_error("Bundle array shape must have a non-zero element count.");
  }
  if (view.byte_length != element_count * element_size) {
    return set_error("Bundle array byte_length does not match shape and dtype.");
  }
  bundle_.arrays[view.key] = array;
  return true;
}

bool Runtime::validate_bundle(const MhrBundleView& bundle_view) {
  if (bundle_view.version != 1) {
    return set_error("Unsupported bundle view version.");
  }
  if (bundle_view.array_count == 0 || bundle_view.arrays == nullptr) {
    return set_error("Bundle view must provide at least one array.");
  }

  bundle_ = BundleData{};
  for (uint32_t index = 0; index < bundle_view.array_count; ++index) {
    const MhrArrayView& view = bundle_view.arrays[index];
    if (!load_array(view)) {
      return false;
    }
  }

  for (const auto& [key, array] : bundle_.arrays) {
    if (!is_required_key(key)) {
      continue;
    }
    if (array.data == nullptr) {
      return set_error("Required bundle array is missing data.");
    }
  }
  for (const std::string_view required_key : {
           std::string_view{"meshTopology"},
           std::string_view{"skinningWeights"},
           std::string_view{"skinningIndices"},
           std::string_view{"bindMatrices"},
           std::string_view{"inverseBindMatrices"},
           std::string_view{"rigTransforms"},
           std::string_view{"jointParents"},
           std::string_view{"parameterTransform"},
           std::string_view{"parameterLimits"},
           std::string_view{"parameterMaskPose"},
           std::string_view{"parameterMaskRigid"},
           std::string_view{"parameterMaskScaling"},
           std::string_view{"blendshapeData"},
           std::string_view{"correctiveData"},
           std::string_view{"correctiveSparseIndices"},
           std::string_view{"correctiveSparseWeights"},
       }) {
    if (!bundle_.arrays.count(std::string(required_key))) {
      std::ostringstream stream;
      stream << "Missing required bundle array: " << required_key;
      return set_error(stream.str());
    }
  }

  const BundleArray& skinning_weights = bundle_.arrays.at("skinningWeights");
  const BundleArray& skinning_indices = bundle_.arrays.at("skinningIndices");
  const BundleArray& bind_matrices = bundle_.arrays.at("bindMatrices");
  const BundleArray& inverse_bind_matrices = bundle_.arrays.at("inverseBindMatrices");
  const BundleArray& rig_transforms = bundle_.arrays.at("rigTransforms");
  const BundleArray& joint_parents = bundle_.arrays.at("jointParents");
  const BundleArray& parameter_transform = bundle_.arrays.at("parameterTransform");
  const BundleArray& parameter_limits = bundle_.arrays.at("parameterLimits");
  const BundleArray& blendshape_data = bundle_.arrays.at("blendshapeData");
  const BundleArray& corrective_data = bundle_.arrays.at("correctiveData");
  const BundleArray& corrective_sparse_indices = bundle_.arrays.at("correctiveSparseIndices");
  const BundleArray& corrective_sparse_weights = bundle_.arrays.at("correctiveSparseWeights");

  if (skinning_weights.scalar_type != MHR_SCALAR_FLOAT32 || skinning_weights.shape.size() != 2) {
    return set_error("skinningWeights must be float32 rank-2.");
  }
  if (skinning_indices.scalar_type != MHR_SCALAR_UINT32 || skinning_indices.shape != skinning_weights.shape) {
    return set_error("skinningIndices must be uint32 and match skinningWeights shape.");
  }
  if (bind_matrices.scalar_type != MHR_SCALAR_FLOAT32 || bind_matrices.shape.size() != 2 ||
      bind_matrices.shape[1] != 8) {
    return set_error("bindMatrices must be float32 with shape [jointCount, 8].");
  }
  if (inverse_bind_matrices.scalar_type != MHR_SCALAR_FLOAT32 ||
      inverse_bind_matrices.shape != bind_matrices.shape) {
    return set_error("inverseBindMatrices must match bindMatrices.");
  }
  if (rig_transforms.scalar_type != MHR_SCALAR_FLOAT32 || rig_transforms.shape.size() != 2 ||
      rig_transforms.shape[1] != 7) {
    return set_error("rigTransforms must be float32 with shape [jointCount, 7].");
  }
  if (joint_parents.scalar_type != MHR_SCALAR_INT32 || joint_parents.shape.size() != 1) {
    return set_error("jointParents must be int32 rank-1.");
  }
  if (parameter_transform.scalar_type != MHR_SCALAR_FLOAT32 ||
      parameter_transform.shape.size() != 2) {
    return set_error("parameterTransform must be float32 rank-2.");
  }
  if (parameter_limits.scalar_type != MHR_SCALAR_FLOAT32 || parameter_limits.shape.size() != 2 ||
      parameter_limits.shape[1] != 2) {
    return set_error("parameterLimits must be float32 with shape [count, 2].");
  }
  if (blendshape_data.scalar_type != MHR_SCALAR_FLOAT32 || blendshape_data.shape.size() != 3 ||
      blendshape_data.shape[2] != 3) {
    return set_error("blendshapeData must be float32 with shape [sliceCount, vertexCount, 3].");
  }
  if (corrective_data.scalar_type != MHR_SCALAR_FLOAT32 || corrective_data.shape.size() != 2) {
    return set_error("correctiveData must be float32 rank-2.");
  }
  if (corrective_sparse_indices.scalar_type != MHR_SCALAR_INT64 ||
      corrective_sparse_indices.shape.size() != 2 ||
      corrective_sparse_indices.shape[0] != 2) {
    return set_error("correctiveSparseIndices must be int64 with shape [2, nnz].");
  }
  if (corrective_sparse_weights.scalar_type != MHR_SCALAR_FLOAT32 ||
      corrective_sparse_weights.shape.size() != 1 ||
      corrective_sparse_weights.shape[0] != corrective_sparse_indices.shape[1]) {
    return set_error("correctiveSparseWeights must be float32 and match sparse index count.");
  }

  bundle_.vertex_count = static_cast<uint32_t>(skinning_weights.shape[0]);
  bundle_.max_influence_count = static_cast<uint32_t>(skinning_weights.shape[1]);
  bundle_.joint_count = static_cast<uint32_t>(joint_parents.shape[0]);
  bundle_.identity_count = kOfficialIdentityCount;
  if (blendshape_data.shape[0] <= (1 + bundle_.identity_count)) {
    return set_error("blendshapeData does not contain expression slices.");
  }
  bundle_.expression_count = static_cast<uint32_t>(blendshape_data.shape[0] - 1 - bundle_.identity_count);
  if (parameter_transform.shape[0] != static_cast<uint64_t>(bundle_.joint_count) * 7ULL) {
    return set_error("parameterTransform row count does not match jointCount * 7.");
  }
  if (parameter_transform.shape[1] <= bundle_.identity_count) {
    return set_error("parameterTransform column count is too small.");
  }
  bundle_.model_parameter_count =
      static_cast<uint32_t>(parameter_transform.shape[1] - bundle_.identity_count);
  if (parameter_limits.shape[0] != parameter_transform.shape[1]) {
    return set_error("parameterLimits row count must match parameterTransform input width.");
  }
  if (blendshape_data.shape[1] != bundle_.vertex_count) {
    return set_error("blendshapeData vertex count must match skinningWeights.");
  }
  if (bind_matrices.shape[0] != bundle_.joint_count || rig_transforms.shape[0] != bundle_.joint_count) {
    return set_error("Joint tuple arrays must agree on jointCount.");
  }
  if (corrective_data.shape[0] != static_cast<uint64_t>(bundle_.vertex_count) * 3ULL) {
    return set_error("correctiveData output size must equal vertexCount * 3.");
  }
  if (corrective_data.shape[1] == 0) {
    return set_error("correctiveData hidden width must be non-zero.");
  }

  return true;
}

bool Runtime::load_bundle(const MhrBundleView& bundle_view) {
  if (!validate_bundle(bundle_view)) {
    return false;
  }

  const BundleArray& corrective_data = bundle_.arrays.at("correctiveData");
  const uint32_t feature_joint_count = bundle_.joint_count > 2U ? bundle_.joint_count - 2U : 0U;
  model_parameters_.assign(bundle_.model_parameter_count, 0.0f);
  identity_.assign(bundle_.identity_count, 0.0f);
  expression_.assign(bundle_.expression_count, 0.0f);
  joint_parameters_.assign(static_cast<size_t>(bundle_.joint_count) * 7U, 0.0f);
  local_skeleton_.assign(static_cast<size_t>(bundle_.joint_count) * 8U, 0.0f);
  skeleton_.assign(static_cast<size_t>(bundle_.joint_count) * 8U, 0.0f);
  rest_vertices_.assign(static_cast<size_t>(bundle_.vertex_count) * 3U, 0.0f);
  pose_features_.assign(static_cast<size_t>(feature_joint_count) * 6U, 0.0f);
  hidden_.assign(static_cast<size_t>(corrective_data.shape[1]), 0.0f);
  corrective_delta_.assign(static_cast<size_t>(bundle_.vertex_count) * 3U, 0.0f);
  skin_joint_states_.assign(static_cast<size_t>(bundle_.joint_count) * 8U, 0.0f);
  vertices_.assign(static_cast<size_t>(bundle_.vertex_count) * 3U, 0.0f);
  derived_.assign(kDerivedValueCount, 0.0f);
  bundle_loaded_ = true;
  evaluated_ = false;
  last_error_.clear();
  return true;
}

bool Runtime::reset_state() {
  if (!require_bundle_loaded()) {
    return set_error("Cannot reset state before a bundle is loaded.");
  }
  std::fill(model_parameters_.begin(), model_parameters_.end(), 0.0f);
  std::fill(identity_.begin(), identity_.end(), 0.0f);
  std::fill(expression_.begin(), expression_.end(), 0.0f);
  std::fill(joint_parameters_.begin(), joint_parameters_.end(), 0.0f);
  std::fill(local_skeleton_.begin(), local_skeleton_.end(), 0.0f);
  std::fill(skeleton_.begin(), skeleton_.end(), 0.0f);
  std::fill(rest_vertices_.begin(), rest_vertices_.end(), 0.0f);
  std::fill(pose_features_.begin(), pose_features_.end(), 0.0f);
  std::fill(hidden_.begin(), hidden_.end(), 0.0f);
  std::fill(corrective_delta_.begin(), corrective_delta_.end(), 0.0f);
  std::fill(skin_joint_states_.begin(), skin_joint_states_.end(), 0.0f);
  std::fill(vertices_.begin(), vertices_.end(), 0.0f);
  std::fill(derived_.begin(), derived_.end(), 0.0f);
  evaluated_ = false;
  last_error_.clear();
  return true;
}

bool Runtime::set_model_parameters(const float* values, uint32_t count) {
  if (!require_bundle_loaded()) {
    return set_error("Cannot set model parameters before a bundle is loaded.");
  }
  if (values == nullptr || count != bundle_.model_parameter_count) {
    return set_error("Model parameter count does not match the loaded bundle.");
  }
  model_parameters_.assign(values, values + count);
  evaluated_ = false;
  return true;
}

bool Runtime::set_identity(const float* values, uint32_t count) {
  if (!require_bundle_loaded()) {
    return set_error("Cannot set identity before a bundle is loaded.");
  }
  if (values == nullptr || count != bundle_.identity_count) {
    return set_error("Identity count does not match the loaded bundle.");
  }
  identity_.assign(values, values + count);
  evaluated_ = false;
  return true;
}

bool Runtime::set_expression(const float* values, uint32_t count) {
  if (!require_bundle_loaded()) {
    return set_error("Cannot set expression before a bundle is loaded.");
  }
  if (values == nullptr || count != bundle_.expression_count) {
    return set_error("Expression count does not match the loaded bundle.");
  }
  expression_.assign(values, values + count);
  evaluated_ = false;
  return true;
}

bool Runtime::get_counts(MhrRuntimeCounts* counts) const {
  if (!bundle_loaded_) {
    return false;
  }
  if (counts == nullptr) {
    return false;
  }
  counts->model_parameter_count = bundle_.model_parameter_count;
  counts->identity_count = bundle_.identity_count;
  counts->expression_count = bundle_.expression_count;
  counts->vertex_count = bundle_.vertex_count;
  counts->joint_count = bundle_.joint_count;
  return true;
}

bool Runtime::copy_vertices(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != vertices_.size()) {
    return false;
  }
  std::copy(vertices_.begin(), vertices_.end(), out_values);
  return true;
}

bool Runtime::copy_joint_parameters(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != joint_parameters_.size()) {
    return false;
  }
  std::copy(joint_parameters_.begin(), joint_parameters_.end(), out_values);
  return true;
}

bool Runtime::copy_local_skeleton(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != local_skeleton_.size()) {
    return false;
  }
  std::copy(local_skeleton_.begin(), local_skeleton_.end(), out_values);
  return true;
}

bool Runtime::copy_rest_vertices(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != rest_vertices_.size()) {
    return false;
  }
  std::copy(rest_vertices_.begin(), rest_vertices_.end(), out_values);
  return true;
}

bool Runtime::copy_pose_features(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != pose_features_.size()) {
    return false;
  }
  std::copy(pose_features_.begin(), pose_features_.end(), out_values);
  return true;
}

bool Runtime::copy_hidden(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != hidden_.size()) {
    return false;
  }
  std::copy(hidden_.begin(), hidden_.end(), out_values);
  return true;
}

bool Runtime::copy_corrective_delta(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != corrective_delta_.size()) {
    return false;
  }
  std::copy(corrective_delta_.begin(), corrective_delta_.end(), out_values);
  return true;
}

bool Runtime::copy_skin_joint_states(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != skin_joint_states_.size()) {
    return false;
  }
  std::copy(skin_joint_states_.begin(), skin_joint_states_.end(), out_values);
  return true;
}

bool Runtime::copy_skeleton(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != skeleton_.size()) {
    return false;
  }
  std::copy(skeleton_.begin(), skeleton_.end(), out_values);
  return true;
}

bool Runtime::copy_derived(float* out_values, uint32_t count) const {
  if (!evaluated_ || out_values == nullptr || count != derived_.size()) {
    return false;
  }
  std::copy(derived_.begin(), derived_.end(), out_values);
  return true;
}

bool Runtime::evaluate() {
  if (!require_bundle_loaded()) {
    return set_error("Cannot evaluate before a bundle is loaded.");
  }

  const BundleArray& parameter_transform = bundle_.arrays.at("parameterTransform");
  const BundleArray& rig_transforms = bundle_.arrays.at("rigTransforms");
  const BundleArray& joint_parents = bundle_.arrays.at("jointParents");
  const BundleArray& blendshape_data = bundle_.arrays.at("blendshapeData");
  const BundleArray& corrective_sparse_indices = bundle_.arrays.at("correctiveSparseIndices");
  const BundleArray& corrective_sparse_weights = bundle_.arrays.at("correctiveSparseWeights");
  const BundleArray& corrective_data = bundle_.arrays.at("correctiveData");
  const BundleArray& skinning_weights = bundle_.arrays.at("skinningWeights");
  const BundleArray& skinning_indices = bundle_.arrays.at("skinningIndices");
  const BundleArray& inverse_bind_matrices = bundle_.arrays.at("inverseBindMatrices");

  const float* parameter_transform_values = array_data<float>(parameter_transform);
  const float* rig_transform_values = array_data<float>(rig_transforms);
  const int32_t* joint_parent_values = array_data<int32_t>(joint_parents);
  const float* blendshape_values = array_data<float>(blendshape_data);
  const int64_t* sparse_index_values = array_data<int64_t>(corrective_sparse_indices);
  const float* sparse_weight_values = array_data<float>(corrective_sparse_weights);
  const float* corrective_dense_values = array_data<float>(corrective_data);
  const float* skinning_weight_values = array_data<float>(skinning_weights);
  const uint32_t* skinning_index_values = array_data<uint32_t>(skinning_indices);
  const float* inverse_bind_values = array_data<float>(inverse_bind_matrices);

  const uint32_t parameter_input_count = bundle_.model_parameter_count + bundle_.identity_count;
  std::vector<float> parameter_inputs(parameter_input_count, 0.0f);
  std::copy(model_parameters_.begin(), model_parameters_.end(), parameter_inputs.begin());
  std::copy(identity_.begin(), identity_.end(), parameter_inputs.begin() + bundle_.model_parameter_count);

  for (uint32_t row = 0; row < bundle_.joint_count * 7U; ++row) {
    double value = 0.0;
    const float* row_values = parameter_transform_values + static_cast<size_t>(row) * parameter_input_count;
    for (uint32_t column = 0; column < parameter_input_count; ++column) {
      value += static_cast<double>(row_values[column]) *
               static_cast<double>(parameter_inputs[column]);
    }
    joint_parameters_[row] = static_cast<float>(value);
  }

  std::vector<Transform> world_transforms(bundle_.joint_count);
  for (uint32_t joint_index = 0; joint_index < bundle_.joint_count; ++joint_index) {
    const float* joint_values = joint_parameters_.data() + static_cast<size_t>(joint_index) * 7U;
    const float* rig_values = rig_transform_values + static_cast<size_t>(joint_index) * 7U;
    Transform local_transform;
    local_transform.translation = Vec3{
        rig_values[0] + joint_values[0],
        rig_values[1] + joint_values[1],
        rig_values[2] + joint_values[2],
    };
    const Quatf local_rotation = quat_multiply_assume_normalizedf(
        Quatf{rig_values[3], rig_values[4], rig_values[5], rig_values[6]},
        euler_xyz_quatf(joint_values[3], joint_values[4], joint_values[5]));
    local_transform.rotation = Quat{
        local_rotation.x,
        local_rotation.y,
        local_rotation.z,
        local_rotation.w,
    };
    local_transform.scale = std::exp(
        static_cast<float>(joint_values[6]) * 0.69314718246459961f);
    write_transform_tuple(
        local_transform,
        local_skeleton_.data() + static_cast<size_t>(joint_index) * 8U);

    const int32_t parent = joint_parent_values[joint_index];
    if (parent < 0) {
      world_transforms[joint_index] = local_transform;
    } else {
      world_transforms[joint_index] = multiply_skel_state(
          world_transforms[static_cast<size_t>(parent)],
          local_transform);
    }
    write_transform_tuple(
        world_transforms[joint_index],
        skeleton_.data() + static_cast<size_t>(joint_index) * 8U);
  }

  const size_t vertex_stride = 3U;
  const size_t vertex_value_count = static_cast<size_t>(bundle_.vertex_count) * vertex_stride;
  std::fill(rest_vertices_.begin(), rest_vertices_.end(), 0.0f);
  std::fill(vertices_.begin(), vertices_.end(), 0.0f);
  const size_t blendshape_slice_stride = vertex_value_count;
  for (size_t offset = 0; offset < vertex_value_count; ++offset) {
    float identity_delta = 0.0f;
    for (uint32_t identity_index = 0; identity_index < bundle_.identity_count; ++identity_index) {
      const float coefficient = identity_[identity_index];
      if (coefficient == 0.0f) {
        continue;
      }
      const float* slice = blendshape_values +
                           static_cast<size_t>(1U + identity_index) * blendshape_slice_stride;
      identity_delta += slice[offset] * coefficient;
    }
    float expression_delta = 0.0f;
    for (uint32_t expression_index = 0; expression_index < bundle_.expression_count; ++expression_index) {
      const float coefficient = expression_[expression_index];
      if (coefficient == 0.0f) {
        continue;
      }
      const float* slice =
          blendshape_values +
          static_cast<size_t>(1U + bundle_.identity_count + expression_index) * blendshape_slice_stride;
      expression_delta += slice[offset] * coefficient;
    }
    rest_vertices_[offset] = blendshape_values[offset] + identity_delta + expression_delta;
  }

  const uint32_t feature_joint_count = bundle_.joint_count > 2U ? bundle_.joint_count - 2U : 0U;
  const uint32_t feature_count = feature_joint_count * 6U;
  std::fill(pose_features_.begin(), pose_features_.end(), 0.0f);
  for (uint32_t joint_index = 2; joint_index < bundle_.joint_count; ++joint_index) {
    const float* joint_values = joint_parameters_.data() + static_cast<size_t>(joint_index) * 7U;
    const float rx = joint_values[3];
    const float ry = joint_values[4];
    const float rz = joint_values[5];
    const float cx = std::cos(rx);
    const float cy = std::cos(ry);
    const float cz = std::cos(rz);
    const float sx = std::sin(rx);
    const float sy = std::sin(ry);
    const float sz = std::sin(rz);
    const size_t offset = static_cast<size_t>(joint_index - 2U) * 6U;
    pose_features_[offset + 0] = cy * cz - 1.0f;
    pose_features_[offset + 1] = cy * sz;
    pose_features_[offset + 2] = -sy;
    pose_features_[offset + 3] = -cx * sz + sx * sy * cz;
    pose_features_[offset + 4] = cx * cz + sx * sy * sz - 1.0f;
    pose_features_[offset + 5] = sx * cy;
  }

  const uint32_t hidden_count = static_cast<uint32_t>(corrective_data.shape[1]);
  std::fill(hidden_.begin(), hidden_.end(), 0.0f);
  const uint64_t sparse_entry_count = corrective_sparse_indices.shape[1];
  for (uint64_t entry_index = 0; entry_index < sparse_entry_count; ++entry_index) {
    const uint32_t output_index = static_cast<uint32_t>(sparse_index_values[entry_index]);
    const uint32_t input_index =
        static_cast<uint32_t>(sparse_index_values[sparse_entry_count + entry_index]);
    if (output_index >= hidden_count || input_index >= feature_count) {
      return set_error("Pose corrective sparse indices exceed feature bounds.");
    }
    hidden_[output_index] += sparse_weight_values[entry_index] * pose_features_[input_index];
  }
  for (float& value : hidden_) {
    value = std::max(value, 0.0f);
  }

  std::fill(corrective_delta_.begin(), corrective_delta_.end(), 0.0f);
  for (size_t offset = 0; offset < vertex_value_count; ++offset) {
    double corrective_delta = 0.0;
    const float* row = corrective_dense_values + offset * hidden_count;
    for (uint32_t column = 0; column < hidden_count; ++column) {
      corrective_delta +=
          static_cast<double>(row[column]) * static_cast<double>(hidden_[column]);
    }
    corrective_delta_[offset] = static_cast<float>(corrective_delta);
    rest_vertices_[offset] += corrective_delta_[offset];
  }

  for (uint32_t joint_index = 0; joint_index < bundle_.joint_count; ++joint_index) {
    const float* global_state = skeleton_.data() + static_cast<size_t>(joint_index) * 8U;
    const float* inverse_bind_state =
        inverse_bind_values + static_cast<size_t>(joint_index) * 8U;
    const Quatf parent_rotation = normalize_quatf(
        Quatf{global_state[3], global_state[4], global_state[5], global_state[6]});
    const Quatf local_rotation = normalize_quatf(Quatf{
        inverse_bind_state[3],
        inverse_bind_state[4],
        inverse_bind_state[5],
        inverse_bind_state[6],
    });
    const Vec3f rotated = rotate_vec_assume_normalizedf(
        parent_rotation,
        Vec3f{inverse_bind_state[0], inverse_bind_state[1], inverse_bind_state[2]});
    const size_t skin_offset = static_cast<size_t>(joint_index) * 8U;
    skin_joint_states_[skin_offset + 0] =
        global_state[0] + global_state[7] * rotated.x;
    skin_joint_states_[skin_offset + 1] =
        global_state[1] + global_state[7] * rotated.y;
    skin_joint_states_[skin_offset + 2] =
        global_state[2] + global_state[7] * rotated.z;
    const Quatf joint_rotation =
        quat_multiply_assume_normalizedf(parent_rotation, local_rotation);
    skin_joint_states_[skin_offset + 3] = joint_rotation.x;
    skin_joint_states_[skin_offset + 4] = joint_rotation.y;
    skin_joint_states_[skin_offset + 5] = joint_rotation.z;
    skin_joint_states_[skin_offset + 6] = joint_rotation.w;
    skin_joint_states_[skin_offset + 7] = global_state[7] * inverse_bind_state[7];
  }

  float min_y = std::numeric_limits<float>::infinity();
  float max_y = -std::numeric_limits<float>::infinity();
  for (uint32_t vertex_index = 0; vertex_index < bundle_.vertex_count; ++vertex_index) {
    const size_t base_offset = static_cast<size_t>(vertex_index) * vertex_stride;
    const Vec3f rest_point{
        rest_vertices_[base_offset + 0],
        rest_vertices_[base_offset + 1],
        rest_vertices_[base_offset + 2],
    };
    Vec3f skinned{};
    for (uint32_t influence_index = 0; influence_index < bundle_.max_influence_count; ++influence_index) {
      const size_t influence_offset =
          static_cast<size_t>(vertex_index) * bundle_.max_influence_count + influence_index;
      const float weight = skinning_weight_values[influence_offset];
      if (weight == 0.0f) {
        continue;
      }
      const uint32_t joint_index = skinning_index_values[influence_offset];
      if (joint_index >= bundle_.joint_count) {
        return set_error("Skinning joint index exceeds jointCount.");
      }
      const float* skin_joint_state =
          skin_joint_states_.data() + static_cast<size_t>(joint_index) * 8U;
      const Vec3f transformed = apply_point_transformf(
          tuple_transformf(skin_joint_state),
          rest_point);
      skinned.x += transformed.x * weight;
      skinned.y += transformed.y * weight;
      skinned.z += transformed.z * weight;
    }
    vertices_[base_offset + 0] = skinned.x;
    vertices_[base_offset + 1] = skinned.y;
    vertices_[base_offset + 2] = skinned.z;
    min_y = std::min(min_y, skinned.y);
    max_y = std::max(max_y, skinned.y);
  }

  derived_[0] = skeleton_[0];
  derived_[1] = skeleton_[1];
  derived_[2] = skeleton_[2];
  derived_[3] = vertices_[0];
  derived_[4] = vertices_[1];
  derived_[5] = vertices_[2];
  derived_[6] = max_y - min_y;
  evaluated_ = true;
  last_error_.clear();
  return true;
}

}  // namespace mhr
