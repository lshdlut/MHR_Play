#define MHR_NATIVE_BUILD

#include "mhr_model_data_api.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <filesystem>
#include <limits>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

using SteadyClock = std::chrono::steady_clock;

constexpr uint32_t kDerivedValueCount = 7;

#ifdef _WIN32
using VsUnaryFn = void(__cdecl*)(int, const float*, float*);
using CblasSgemvFn = void(__cdecl*)(
    int,
    int,
    int,
    int,
    float,
    const float*,
    int,
    const float*,
    int,
    float,
    float*,
    int);

constexpr int kCblasRowMajor = 101;
constexpr int kCblasNoTrans = 111;

struct ExactKernelFunctions final {
  HMODULE mkl_module = nullptr;
  HMODULE cblas_module = nullptr;
  VsUnaryFn vs_sin = nullptr;
  VsUnaryFn vs_cos = nullptr;
  CblasSgemvFn cblas_sgemv = nullptr;
};
#endif

struct BundleArray final {
  MhrScalarType scalar_type = MHR_SCALAR_FLOAT32;
  std::vector<uint64_t> shape;
  const void* data = nullptr;
  size_t byte_length = 0;
};

struct SparseMatrixSummary final {
  uint32_t rows = 0;
  uint32_t columns = 0;
  uint64_t nnz = 0;
  float exact_zero_fraction = 0.0f;
  uint32_t max_row_nnz = 0;
  uint32_t max_column_nnz = 0;
};

struct SparseRowMatrix final {
  std::vector<uint32_t> row_ptr;
  std::vector<uint32_t> col_index;
  std::vector<float> values;
  SparseMatrixSummary summary;
};

struct SparseColumnMatrix final {
  std::vector<uint32_t> col_ptr;
  std::vector<uint32_t> row_index;
  std::vector<float> values;
  SparseMatrixSummary summary;
};

struct DenseMatrix final {
  std::vector<float> values;
  uint32_t rows = 0;
  uint32_t columns = 0;
};

struct Vec3 final {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

struct Quat final {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double w = 1.0;
};

struct Transform final {
  Vec3 translation;
  Quat rotation;
  double scale = 1.0;
};

struct Vec3f final {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;
};

struct Quatf final {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;
  float w = 1.0f;
};

struct Transformf final {
  Vec3f translation;
  Quatf rotation;
  float scale = 1.0f;
};

struct CompiledModel final {
  std::unordered_map<std::string, BundleArray> arrays;
  const float* base_mesh = nullptr;
  const float* identity_basis = nullptr;
  const float* expression_basis = nullptr;
  const float* rig_translation_offsets = nullptr;
  const float* rig_prerotations = nullptr;
  const float* inverse_bind_pose = nullptr;
  const float* skinning_weights = nullptr;
  const float* pose_corrective_stage2_dense = nullptr;
  const uint32_t* skinning_indices = nullptr;
  const uint32_t* prefix_mul_level_offsets = nullptr;
  const uint32_t* prefix_mul_source = nullptr;
  const uint32_t* prefix_mul_target = nullptr;
  const uint32_t* pose_block_feature_offsets = nullptr;
  const uint32_t* pose_block_hidden_offsets = nullptr;
  const uint32_t* corrective_block_row_offsets = nullptr;
  const uint32_t* corrective_block_row_index = nullptr;
  const int32_t* joint_parents = nullptr;
  uint32_t prefix_mul_level_count = 0;
  uint32_t prefix_mul_pair_count = 0;
  SparseRowMatrix parameter_transform;
  SparseRowMatrix pose_corrective_stage1;
  SparseColumnMatrix pose_corrective_stage2;
  mutable DenseMatrix parameter_transform_dense;
  mutable DenseMatrix pose_corrective_stage1_dense;
  mutable std::once_flag parameter_transform_dense_once;
  mutable std::once_flag pose_corrective_stage1_dense_once;
  MhrModelCounts counts{};
  MhrPoseBlockLayout pose_layout{0, 6, 24};
  std::string last_error;
};

struct WorkspaceData final {
  std::vector<float> model_parameters;
  std::vector<float> identity;
  std::vector<float> expression;
  std::vector<float> parameter_inputs;
  std::vector<double> joint_parameters_fp64;
  std::vector<Transform> world_transforms_fp64;
  std::vector<float> joint_parameters;
  std::vector<float> local_transforms;
  std::vector<float> global_transforms;
  std::vector<float> skin_transforms;
  std::vector<float> pose_features;
  std::vector<float> hidden;
  std::vector<float> corrective_delta;
  std::vector<float> rest_vertices_pre_corrective;
  std::vector<float> rest_vertices;
  std::vector<float> output_vertices;
  std::vector<float> skeleton;
  std::vector<float> derived;
  MhrRuntimeDebugTiming timing{};
  bool cache_available = false;
  bool evaluated = false;
  bool derived_valid = false;
  bool model_parameters_dirty = true;
  bool identity_dirty = true;
  bool expression_dirty = true;
  std::string last_error;
};

bool set_error(std::string* target, const std::string& message) {
  *target = message;
  return false;
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

uint64_t element_count(const BundleArray& array) {
  uint64_t count = 1;
  for (const uint64_t dim : array.shape) {
    count *= dim;
  }
  return count;
}

uint32_t max_u32_inclusive(const uint32_t* values, uint32_t count) {
  uint32_t result = 0;
  for (uint32_t index = 0; index < count; ++index) {
    result = std::max(result, values[index]);
  }
  return result;
}

float elapsed_ms(
    const SteadyClock::time_point& start,
    const SteadyClock::time_point& end) {
  return std::chrono::duration_cast<std::chrono::duration<float, std::milli>>(end - start)
      .count();
}

bool float_vector_matches(
    const std::vector<float>& current,
    const float* incoming,
    uint32_t count) {
  return current.size() == static_cast<size_t>(count) &&
         std::equal(current.begin(), current.end(), incoming);
}

bool float_vector_equal(
    const std::vector<float>& left,
    const std::vector<float>& right) {
  return left.size() == right.size() &&
         std::equal(left.begin(), left.end(), right.begin());
}

struct ActiveBasisTerm final {
  const float* basis = nullptr;
  float coefficient = 0.0f;
};

std::vector<ActiveBasisTerm> build_active_basis_terms(
    const float* basis_table,
    const std::vector<float>& coefficients,
    size_t value_count) {
  std::vector<ActiveBasisTerm> active_terms;
  active_terms.reserve(coefficients.size());
  for (size_t index = 0; index < coefficients.size(); ++index) {
    const float coefficient = coefficients[index];
    if (coefficient == 0.0f) {
      continue;
    }
    active_terms.push_back(
        ActiveBasisTerm{basis_table + index * value_count, coefficient});
  }
  return active_terms;
}

void accumulate_active_basis_terms(
    std::vector<float>* target,
    const std::vector<ActiveBasisTerm>& active_terms) {
  if (target == nullptr || active_terms.empty()) {
    return;
  }
  for (const ActiveBasisTerm& term : active_terms) {
    float* out = target->data();
    const float* basis = term.basis;
    const float coefficient = term.coefficient;
    for (size_t offset = 0; offset < target->size(); ++offset) {
      out[offset] += basis[offset] * coefficient;
    }
  }
}

void compose_surface_morph_exact(
    const float* base_mesh,
    const std::vector<ActiveBasisTerm>& active_identity,
    const std::vector<ActiveBasisTerm>& active_expression,
    std::vector<float>* target) {
  if (base_mesh == nullptr || target == nullptr) {
    return;
  }
  for (size_t offset = 0; offset < target->size(); ++offset) {
    float delta = 0.0f;
    for (const ActiveBasisTerm& term : active_identity) {
      delta += term.basis[offset] * term.coefficient;
    }
    for (const ActiveBasisTerm& term : active_expression) {
      delta += term.basis[offset] * term.coefficient;
    }
    (*target)[offset] = base_mesh[offset] + delta;
  }
}

void compose_rest_vertices(
    const std::vector<float>& rest_vertices_pre_corrective,
    const std::vector<float>& corrective_delta,
    std::vector<float>* rest_vertices) {
  if (rest_vertices == nullptr) {
    return;
  }
  for (size_t index = 0; index < rest_vertices->size(); ++index) {
    (*rest_vertices)[index] =
        rest_vertices_pre_corrective[index] + corrective_delta[index];
  }
}

void compose_rest_vertices_rows(
    const std::vector<float>& rest_vertices_pre_corrective,
    const std::vector<float>& corrective_delta,
    const std::vector<uint32_t>& touched_rows,
    std::vector<float>* rest_vertices) {
  if (rest_vertices == nullptr) {
    return;
  }
  for (const uint32_t row : touched_rows) {
    (*rest_vertices)[row] = rest_vertices_pre_corrective[row] + corrective_delta[row];
  }
}

uint32_t find_pose_block_for_hidden_index(
    const uint32_t* hidden_offsets,
    uint32_t block_count,
    uint32_t hidden_index) {
  const uint32_t* begin = hidden_offsets;
  const uint32_t* end = hidden_offsets + block_count + 1U;
  const uint32_t* upper = std::upper_bound(begin, end, hidden_index);
  if (upper == begin) {
    return 0;
  }
  const ptrdiff_t block_index = (upper - begin) - 1;
  if (block_index < 0) {
    return 0;
  }
  if (static_cast<uint32_t>(block_index) >= block_count) {
    return block_count == 0 ? 0 : block_count - 1U;
  }
  return static_cast<uint32_t>(block_index);
}

#ifdef _WIN32
std::filesystem::path env_path(const char* key) {
  char* value = nullptr;
  size_t value_length = 0;
  if (_dupenv_s(&value, &value_length, key) != 0 || value == nullptr || value[0] == '\0') {
    if (value != nullptr) {
      free(value);
    }
    return {};
  }
  std::filesystem::path result(value);
  free(value);
  return result;
}

std::vector<std::filesystem::path> candidate_library_paths(
    const char* override_key,
    const std::initializer_list<const wchar_t*> fallback_names) {
  std::vector<std::filesystem::path> candidates;

  const std::filesystem::path override_path = env_path(override_key);
  if (!override_path.empty()) {
    candidates.push_back(override_path);
  }

  const std::filesystem::path python_executable = env_path("PYTHON_EXE");
  if (!python_executable.empty()) {
    const std::filesystem::path python_root = python_executable.parent_path();
    for (const wchar_t* filename : fallback_names) {
      candidates.push_back(python_root / "Library" / "bin" / filename);
    }
  }

  const std::filesystem::path conda_prefix = env_path("CONDA_PREFIX");
  if (!conda_prefix.empty()) {
    for (const wchar_t* filename : fallback_names) {
      candidates.push_back(conda_prefix / "Library" / "bin" / filename);
    }
  }

  for (const wchar_t* filename : fallback_names) {
    candidates.emplace_back(filename);
  }
  return candidates;
}

HMODULE load_dynamic_library(const std::vector<std::filesystem::path>& candidates) {
  for (const auto& candidate : candidates) {
    if (candidate.empty()) {
      continue;
    }
    if (candidate.has_parent_path() && !std::filesystem::exists(candidate)) {
      continue;
    }
    if (HMODULE module = LoadLibraryW(candidate.c_str())) {
      return module;
    }
  }
  return nullptr;
}

const ExactKernelFunctions* exact_kernels() {
  static ExactKernelFunctions functions;
  static std::once_flag once;
  std::call_once(once, []() {
    functions.mkl_module = GetModuleHandleW(L"mkl_rt.2.dll");
    if (functions.mkl_module == nullptr) {
      functions.mkl_module = GetModuleHandleW(L"mkl_rt.dll");
    }
    if (functions.mkl_module == nullptr) {
      functions.mkl_module = load_dynamic_library(
          candidate_library_paths("MHR_MKL_DLL", {L"mkl_rt.2.dll", L"mkl_rt.dll"}));
    }
    if (functions.mkl_module != nullptr) {
      functions.vs_sin =
          reinterpret_cast<VsUnaryFn>(GetProcAddress(functions.mkl_module, "vsSin"));
      functions.vs_cos =
          reinterpret_cast<VsUnaryFn>(GetProcAddress(functions.mkl_module, "vsCos"));
      functions.cblas_sgemv = reinterpret_cast<CblasSgemvFn>(
          GetProcAddress(functions.mkl_module, "cblas_sgemv"));
    }
    if (functions.cblas_sgemv == nullptr) {
      functions.cblas_module = GetModuleHandleW(L"libcblas.dll");
      if (functions.cblas_module == nullptr) {
        functions.cblas_module =
            load_dynamic_library(candidate_library_paths("MHR_CBLAS_DLL", {L"libcblas.dll"}));
      }
      if (functions.cblas_module != nullptr) {
        functions.cblas_sgemv = reinterpret_cast<CblasSgemvFn>(
            GetProcAddress(functions.cblas_module, "cblas_sgemv"));
      }
    }
  });

  if (functions.vs_sin == nullptr || functions.vs_cos == nullptr ||
      functions.cblas_sgemv == nullptr) {
    return nullptr;
  }
  return &functions;
}

bool exact_sincos3(
    const float x0,
    const float x1,
    const float x2,
    float* out_sin,
    float* out_cos) {
  const ExactKernelFunctions* kernels = exact_kernels();
  if (kernels == nullptr) {
    return false;
  }
  const float input[3] = {x0, x1, x2};
  kernels->vs_sin(3, input, out_sin);
  kernels->vs_cos(3, input, out_cos);
  return true;
}

bool exact_sgemv(
    const int rows,
    const int columns,
    const float* matrix,
    const float* x,
    float* y) {
  const ExactKernelFunctions* kernels = exact_kernels();
  if (kernels == nullptr) {
    return false;
  }
  kernels->cblas_sgemv(
      kCblasRowMajor,
      kCblasNoTrans,
      rows,
      columns,
      1.0f,
      matrix,
      columns,
      x,
      1,
      0.0f,
      y,
      1);
  return true;
}
#endif

Quat normalize_quat(const Quat& q) {
  double norm_sq = q.x * q.x;
  norm_sq += q.y * q.y;
  norm_sq += q.z * q.z;
  norm_sq += q.w * q.w;
  const double norm = std::sqrt(norm_sq);
  if (norm <= std::numeric_limits<double>::epsilon()) {
    return Quat{};
  }
  return Quat{q.x / norm, q.y / norm, q.z / norm, q.w / norm};
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

Quat quat_multiply_assume_normalized(const Quat& a, const Quat& b) {
  return Quat{
      a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
      a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
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
  const Vec3 av{
      axis.y * v.z - axis.z * v.y,
      axis.z * v.x - axis.x * v.z,
      axis.x * v.y - axis.y * v.x,
  };
  const Vec3 aav{
      axis.y * av.z - axis.z * av.y,
      axis.z * av.x - axis.x * av.z,
      axis.x * av.y - axis.y * av.x,
  };
  return Vec3{
      v.x + 2.0 * (av.x * q.w + aav.x),
      v.y + 2.0 * (av.y * q.w + aav.y),
      v.z + 2.0 * (av.z * q.w + aav.z),
  };
}

Vec3f rotate_vec_assume_normalizedf(const Quatf& q, const Vec3f& v) {
  const Vec3f axis{q.x, q.y, q.z};
  const Vec3f av{
      axis.y * v.z - axis.z * v.y,
      axis.z * v.x - axis.x * v.z,
      axis.x * v.y - axis.y * v.x,
  };
  const Vec3f aav{
      axis.y * av.z - axis.z * av.y,
      axis.z * av.x - axis.x * av.z,
      axis.x * av.y - axis.y * av.x,
  };
  return Vec3f{
      v.x + 2.0f * (av.x * q.w + aav.x),
      v.y + 2.0f * (av.y * q.w + aav.y),
      v.z + 2.0f * (av.z * q.w + aav.z),
  };
}

Quatf euler_xyz_quatf(float rx, float ry, float rz) {
#ifdef _WIN32
  float sin_values[3];
  float cos_values[3];
  if (exact_sincos3(rx * 0.5f, ry * 0.5f, rz * 0.5f, sin_values, cos_values)) {
    const float sr = sin_values[0];
    const float sp = sin_values[1];
    const float sy = sin_values[2];
    const float cr = cos_values[0];
    const float cp = cos_values[1];
    const float cy = cos_values[2];
    return Quatf{
        sr * cp * cy - cr * sp * sy,
        cr * sp * cy + sr * cp * sy,
        cr * cp * sy - sr * sp * cy,
        cr * cp * cy + sr * sp * sy,
    };
  }
#endif
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
  const Vec3f scaled{
      point.x * transform.scale,
      point.y * transform.scale,
      point.z * transform.scale,
  };
  const Vec3f rotated = rotate_vec_assume_normalizedf(rotation, scaled);
  return Vec3f{
      transform.translation.x + rotated.x,
      transform.translation.y + rotated.y,
      transform.translation.z + rotated.z,
  };
}

Transformf tuple_transformf(const float* values) {
  return Transformf{
      Vec3f{values[0], values[1], values[2]},
      Quatf{values[3], values[4], values[5], values[6]},
      values[7],
  };
}

float canonicalize_zero(float value) {
  return value == 0.0f ? 0.0f : value;
}

void write_transform_tuple(const Transform& transform, float* out_values) {
  out_values[0] = canonicalize_zero(static_cast<float>(transform.translation.x));
  out_values[1] = canonicalize_zero(static_cast<float>(transform.translation.y));
  out_values[2] = canonicalize_zero(static_cast<float>(transform.translation.z));
  out_values[3] = canonicalize_zero(static_cast<float>(transform.rotation.x));
  out_values[4] = canonicalize_zero(static_cast<float>(transform.rotation.y));
  out_values[5] = canonicalize_zero(static_cast<float>(transform.rotation.z));
  out_values[6] = canonicalize_zero(static_cast<float>(transform.rotation.w));
  out_values[7] = canonicalize_zero(static_cast<float>(transform.scale));
}

void write_transform_tuple(const Transformf& transform, float* out_values) {
  out_values[0] = canonicalize_zero(transform.translation.x);
  out_values[1] = canonicalize_zero(transform.translation.y);
  out_values[2] = canonicalize_zero(transform.translation.z);
  out_values[3] = canonicalize_zero(transform.rotation.x);
  out_values[4] = canonicalize_zero(transform.rotation.y);
  out_values[5] = canonicalize_zero(transform.rotation.z);
  out_values[6] = canonicalize_zero(transform.rotation.w);
  out_values[7] = canonicalize_zero(transform.scale);
}

bool load_array(
    std::unordered_map<std::string, BundleArray>* arrays,
    std::string* last_error,
    const MhrArrayView& view) {
  if (view.key == nullptr || view.key[0] == '\0') {
    return set_error(last_error, "Bundle array key must be non-empty.");
  }
  if (view.rank > 0 && view.shape == nullptr) {
    return set_error(last_error, "Bundle array shape is required when rank > 0.");
  }
  BundleArray array;
  array.scalar_type = view.scalar_type;
  array.data = view.data;
  array.byte_length = view.byte_length;
  array.shape.assign(view.shape, view.shape + view.rank);
  const size_t expected_byte_length = static_cast<size_t>(element_count(array)) * scalar_type_size(array.scalar_type);
  if (expected_byte_length != array.byte_length) {
    std::ostringstream stream;
    stream << "Bundle array byte length mismatch for key: " << view.key;
    return set_error(last_error, stream.str());
  }
  arrays->insert_or_assign(std::string(view.key), array);
  return true;
}

bool require_key(
    const std::unordered_map<std::string, BundleArray>& arrays,
    std::string* last_error,
    std::string_view key) {
  if (!arrays.count(std::string(key))) {
    std::ostringstream stream;
    stream << "Missing required bundle array: " << key;
    return set_error(last_error, stream.str());
  }
  return true;
}

SparseRowMatrix dense_to_csr(const float* data, uint32_t rows, uint32_t cols) {
  SparseRowMatrix matrix;
  matrix.row_ptr.reserve(static_cast<size_t>(rows) + 1U);
  matrix.row_ptr.push_back(0U);
  std::vector<uint32_t> col_counts(cols, 0U);
  uint64_t exact_zero_count = 0;

  for (uint32_t row = 0; row < rows; ++row) {
    uint32_t row_nnz = 0;
    const size_t row_offset = static_cast<size_t>(row) * cols;
    for (uint32_t col = 0; col < cols; ++col) {
      const float value = data[row_offset + col];
      if (value == 0.0f) {
        ++exact_zero_count;
        continue;
      }
      matrix.col_index.push_back(col);
      matrix.values.push_back(value);
      ++row_nnz;
      ++col_counts[col];
    }
    matrix.summary.max_row_nnz = std::max(matrix.summary.max_row_nnz, row_nnz);
    matrix.row_ptr.push_back(static_cast<uint32_t>(matrix.col_index.size()));
  }

  for (const uint32_t count : col_counts) {
    matrix.summary.max_column_nnz = std::max(matrix.summary.max_column_nnz, count);
  }

  matrix.summary.rows = rows;
  matrix.summary.columns = cols;
  matrix.summary.nnz = matrix.values.size();
  matrix.summary.exact_zero_fraction =
      rows == 0 || cols == 0
          ? 0.0f
          : static_cast<float>(static_cast<double>(exact_zero_count) /
                               static_cast<double>(static_cast<uint64_t>(rows) * cols));
  return matrix;
}

SparseColumnMatrix dense_to_csc(const float* data, uint32_t rows, uint32_t cols) {
  SparseColumnMatrix matrix;
  matrix.col_ptr.reserve(static_cast<size_t>(cols) + 1U);
  matrix.col_ptr.push_back(0U);
  std::vector<uint32_t> row_counts(rows, 0U);
  uint64_t exact_zero_count = 0;

  for (uint32_t col = 0; col < cols; ++col) {
    uint32_t col_nnz = 0;
    for (uint32_t row = 0; row < rows; ++row) {
      const float value = data[static_cast<size_t>(row) * cols + col];
      if (value == 0.0f) {
        ++exact_zero_count;
        continue;
      }
      matrix.row_index.push_back(row);
      matrix.values.push_back(value);
      ++col_nnz;
      ++row_counts[row];
    }
    matrix.summary.max_column_nnz = std::max(matrix.summary.max_column_nnz, col_nnz);
    matrix.col_ptr.push_back(static_cast<uint32_t>(matrix.row_index.size()));
  }

  for (const uint32_t count : row_counts) {
    matrix.summary.max_row_nnz = std::max(matrix.summary.max_row_nnz, count);
  }

  matrix.summary.rows = rows;
  matrix.summary.columns = cols;
  matrix.summary.nnz = matrix.values.size();
  matrix.summary.exact_zero_fraction =
      rows == 0 || cols == 0
          ? 0.0f
          : static_cast<float>(static_cast<double>(exact_zero_count) /
                               static_cast<double>(static_cast<uint64_t>(rows) * cols));
  return matrix;
}

SparseRowMatrix coo_to_csr(
    const int64_t* indices,
    const float* values,
    uint32_t row_count,
    uint32_t column_count,
    uint32_t nnz) {
  struct Entry final {
    uint32_t row;
    uint32_t column;
    float value;
  };

  std::vector<Entry> entries;
  entries.reserve(nnz);
  std::vector<uint32_t> row_counts(row_count, 0U);
  std::vector<uint32_t> col_counts(column_count, 0U);
  for (uint32_t entry_index = 0; entry_index < nnz; ++entry_index) {
    const uint32_t row = static_cast<uint32_t>(indices[entry_index]);
    const uint32_t column = static_cast<uint32_t>(indices[nnz + entry_index]);
    entries.push_back(Entry{row, column, values[entry_index]});
    ++row_counts[row];
    ++col_counts[column];
  }
  std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
    if (a.row != b.row) {
      return a.row < b.row;
    }
    return a.column < b.column;
  });

  SparseRowMatrix matrix;
  matrix.row_ptr.reserve(static_cast<size_t>(row_count) + 1U);
  matrix.row_ptr.push_back(0U);
  uint32_t cursor = 0;
  for (uint32_t row = 0; row < row_count; ++row) {
    const uint32_t count = row_counts[row];
    matrix.summary.max_row_nnz = std::max(matrix.summary.max_row_nnz, count);
    cursor += count;
    matrix.row_ptr.push_back(cursor);
  }
  for (const uint32_t count : col_counts) {
    matrix.summary.max_column_nnz = std::max(matrix.summary.max_column_nnz, count);
  }

  matrix.col_index.reserve(nnz);
  matrix.values.reserve(nnz);
  for (const Entry& entry : entries) {
    matrix.col_index.push_back(entry.column);
    matrix.values.push_back(entry.value);
  }

  matrix.summary.rows = row_count;
  matrix.summary.columns = column_count;
  matrix.summary.nnz = nnz;
  matrix.summary.exact_zero_fraction = 0.0f;
  return matrix;
}

SparseMatrixSummary summarize_csr(
    const uint32_t* row_ptr,
    const uint32_t* col_index,
    uint32_t rows,
    uint32_t columns) {
  SparseMatrixSummary summary{};
  summary.rows = rows;
  summary.columns = columns;
  summary.nnz = row_ptr[rows];
  std::vector<uint32_t> column_counts(columns, 0U);
  for (uint32_t row = 0; row < rows; ++row) {
    const uint32_t start = row_ptr[row];
    const uint32_t end = row_ptr[row + 1];
    summary.max_row_nnz = std::max(summary.max_row_nnz, end - start);
    for (uint32_t cursor = start; cursor < end; ++cursor) {
      ++column_counts[col_index[cursor]];
    }
  }
  for (const uint32_t count : column_counts) {
    summary.max_column_nnz = std::max(summary.max_column_nnz, count);
  }
  const double total = static_cast<double>(rows) * static_cast<double>(columns);
  summary.exact_zero_fraction =
      total == 0.0 ? 0.0f : static_cast<float>((total - static_cast<double>(summary.nnz)) / total);
  return summary;
}

SparseMatrixSummary summarize_csc(
    const uint32_t* col_ptr,
    const uint32_t* row_index,
    uint32_t rows,
    uint32_t columns) {
  SparseMatrixSummary summary{};
  summary.rows = rows;
  summary.columns = columns;
  summary.nnz = col_ptr[columns];
  std::vector<uint32_t> row_counts(rows, 0U);
  for (uint32_t column = 0; column < columns; ++column) {
    const uint32_t start = col_ptr[column];
    const uint32_t end = col_ptr[column + 1];
    summary.max_column_nnz = std::max(summary.max_column_nnz, end - start);
    for (uint32_t cursor = start; cursor < end; ++cursor) {
      ++row_counts[row_index[cursor]];
    }
  }
  for (const uint32_t count : row_counts) {
    summary.max_row_nnz = std::max(summary.max_row_nnz, count);
  }
  const double total = static_cast<double>(rows) * static_cast<double>(columns);
  summary.exact_zero_fraction =
      total == 0.0 ? 0.0f : static_cast<float>((total - static_cast<double>(summary.nnz)) / total);
  return summary;
}

DenseMatrix csr_to_dense(const SparseRowMatrix& matrix) {
  DenseMatrix dense;
  dense.rows = matrix.summary.rows;
  dense.columns = matrix.summary.columns;
  dense.values.assign(static_cast<size_t>(dense.rows) * dense.columns, 0.0f);
  for (uint32_t row = 0; row < dense.rows; ++row) {
    const uint32_t start = matrix.row_ptr[row];
    const uint32_t end = matrix.row_ptr[row + 1];
    float* out_row = dense.values.data() + static_cast<size_t>(row) * dense.columns;
    for (uint32_t cursor = start; cursor < end; ++cursor) {
      out_row[matrix.col_index[cursor]] = matrix.values[cursor];
    }
  }
  return dense;
}

const DenseMatrix& parameter_transform_dense_matrix(const CompiledModel& model) {
  std::call_once(model.parameter_transform_dense_once, [&model]() {
    model.parameter_transform_dense = csr_to_dense(model.parameter_transform);
  });
  return model.parameter_transform_dense;
}

const DenseMatrix& pose_corrective_stage1_dense_matrix(const CompiledModel& model) {
  std::call_once(model.pose_corrective_stage1_dense_once, [&model]() {
    model.pose_corrective_stage1_dense = csr_to_dense(model.pose_corrective_stage1);
  });
  return model.pose_corrective_stage1_dense;
}

bool validate_bundle(CompiledModel* model, const MhrBundleView& bundle_view) {
  if (bundle_view.version != 1) {
    return set_error(&model->last_error, "Unsupported bundle view version.");
  }
  if (bundle_view.array_count == 0 || bundle_view.arrays == nullptr) {
    return set_error(&model->last_error, "Bundle view must provide at least one array.");
  }

  model->arrays.clear();
  model->last_error.clear();
  for (uint32_t index = 0; index < bundle_view.array_count; ++index) {
    if (!load_array(&model->arrays, &model->last_error, bundle_view.arrays[index])) {
      return false;
    }
  }

  for (const std::string_view key : {
           std::string_view{"meshTopology"},
           std::string_view{"skinningWeights"},
           std::string_view{"skinningIndices"},
           std::string_view{"bindPose"},
           std::string_view{"inverseBindPose"},
           std::string_view{"rigTranslationOffsets"},
           std::string_view{"rigPrerotations"},
           std::string_view{"jointParents"},
           std::string_view{"prefixMulLevelOffsets"},
           std::string_view{"prefixMulSource"},
           std::string_view{"prefixMulTarget"},
           std::string_view{"parameterLimits"},
           std::string_view{"parameterMaskPose"},
           std::string_view{"parameterMaskRigid"},
           std::string_view{"parameterMaskScaling"},
           std::string_view{"baseMesh"},
           std::string_view{"identityBasis"},
           std::string_view{"expressionBasis"},
           std::string_view{"parameterTransformRowPtr"},
           std::string_view{"parameterTransformColIndex"},
           std::string_view{"parameterTransformValues"},
           std::string_view{"poseHiddenRowPtr"},
           std::string_view{"poseHiddenFeatureIndex"},
           std::string_view{"poseHiddenValues"},
           std::string_view{"correctiveColPtr"},
           std::string_view{"correctiveRowIndex"},
           std::string_view{"correctiveValues"},
           std::string_view{"poseBlockFeatureOffsets"},
           std::string_view{"poseBlockHiddenOffsets"},
           std::string_view{"correctiveBlockRowOffsets"},
           std::string_view{"correctiveBlockRowIndex"},
       }) {
    if (!require_key(model->arrays, &model->last_error, key)) {
      return false;
    }
  }

  const BundleArray& skinning_weights = model->arrays.at("skinningWeights");
  const BundleArray& skinning_indices = model->arrays.at("skinningIndices");
  const BundleArray& bind_pose = model->arrays.at("bindPose");
  const BundleArray& inverse_bind_pose = model->arrays.at("inverseBindPose");
  const BundleArray& rig_translation_offsets = model->arrays.at("rigTranslationOffsets");
  const BundleArray& rig_prerotations = model->arrays.at("rigPrerotations");
  const BundleArray& joint_parents = model->arrays.at("jointParents");
  const BundleArray& prefix_mul_level_offsets = model->arrays.at("prefixMulLevelOffsets");
  const BundleArray& prefix_mul_source = model->arrays.at("prefixMulSource");
  const BundleArray& prefix_mul_target = model->arrays.at("prefixMulTarget");
  const BundleArray& parameter_limits = model->arrays.at("parameterLimits");
  const BundleArray& parameter_mask_pose = model->arrays.at("parameterMaskPose");
  const BundleArray& parameter_mask_rigid = model->arrays.at("parameterMaskRigid");
  const BundleArray& parameter_mask_scaling = model->arrays.at("parameterMaskScaling");
  const BundleArray& base_mesh = model->arrays.at("baseMesh");
  const BundleArray& identity_basis = model->arrays.at("identityBasis");
  const BundleArray& expression_basis = model->arrays.at("expressionBasis");
  const BundleArray& parameter_transform_row_ptr = model->arrays.at("parameterTransformRowPtr");
  const BundleArray& parameter_transform_col_index = model->arrays.at("parameterTransformColIndex");
  const BundleArray& parameter_transform_values = model->arrays.at("parameterTransformValues");
  const BundleArray& pose_hidden_row_ptr = model->arrays.at("poseHiddenRowPtr");
  const BundleArray& pose_hidden_feature_index = model->arrays.at("poseHiddenFeatureIndex");
  const BundleArray& pose_hidden_values = model->arrays.at("poseHiddenValues");
  const BundleArray& corrective_col_ptr = model->arrays.at("correctiveColPtr");
  const BundleArray& corrective_row_index = model->arrays.at("correctiveRowIndex");
  const BundleArray& corrective_values = model->arrays.at("correctiveValues");
  const BundleArray& pose_block_feature_offsets = model->arrays.at("poseBlockFeatureOffsets");
  const BundleArray& pose_block_hidden_offsets = model->arrays.at("poseBlockHiddenOffsets");
  const BundleArray& corrective_block_row_offsets = model->arrays.at("correctiveBlockRowOffsets");
  const BundleArray& corrective_block_row_index = model->arrays.at("correctiveBlockRowIndex");

  if (skinning_weights.scalar_type != MHR_SCALAR_FLOAT32 || skinning_weights.shape.size() != 2) {
    return set_error(&model->last_error, "skinningWeights must be float32 rank-2.");
  }
  if (skinning_indices.scalar_type != MHR_SCALAR_UINT32 || skinning_indices.shape != skinning_weights.shape) {
    return set_error(&model->last_error, "skinningIndices must match skinningWeights.");
  }
  if (bind_pose.scalar_type != MHR_SCALAR_FLOAT32 || bind_pose.shape.size() != 2 || bind_pose.shape[1] != 8) {
    return set_error(&model->last_error, "bindPose must be float32 with shape [jointCount, 8].");
  }
  if (inverse_bind_pose.scalar_type != MHR_SCALAR_FLOAT32 || inverse_bind_pose.shape != bind_pose.shape) {
    return set_error(&model->last_error, "inverseBindPose must match bindPose.");
  }
  if (rig_translation_offsets.scalar_type != MHR_SCALAR_FLOAT32 || rig_translation_offsets.shape.size() != 2 || rig_translation_offsets.shape[1] != 3) {
    return set_error(&model->last_error, "rigTranslationOffsets must be float32 with shape [jointCount, 3].");
  }
  if (rig_prerotations.scalar_type != MHR_SCALAR_FLOAT32 || rig_prerotations.shape.size() != 2 || rig_prerotations.shape[1] != 4) {
    return set_error(&model->last_error, "rigPrerotations must be float32 with shape [jointCount, 4].");
  }
  if (joint_parents.scalar_type != MHR_SCALAR_INT32 || joint_parents.shape.size() != 1) {
    return set_error(&model->last_error, "jointParents must be int32 rank-1.");
  }
  if (prefix_mul_level_offsets.scalar_type != MHR_SCALAR_UINT32 ||
      prefix_mul_level_offsets.shape.size() != 1) {
    return set_error(&model->last_error, "prefixMulLevelOffsets must be uint32 rank-1.");
  }
  if (prefix_mul_source.scalar_type != MHR_SCALAR_UINT32 || prefix_mul_source.shape.size() != 1) {
    return set_error(&model->last_error, "prefixMulSource must be uint32 rank-1.");
  }
  if (prefix_mul_target.scalar_type != MHR_SCALAR_UINT32 || prefix_mul_target.shape != prefix_mul_source.shape) {
    return set_error(&model->last_error, "prefixMulTarget must match prefixMulSource.");
  }
  if (parameter_limits.scalar_type != MHR_SCALAR_FLOAT32 || parameter_limits.shape.size() != 2 || parameter_limits.shape[1] != 2) {
    return set_error(&model->last_error, "parameterLimits must be float32 with shape [count, 2].");
  }
  if (parameter_mask_pose.scalar_type != MHR_SCALAR_UINT8 || parameter_mask_pose.shape.size() != 1) {
    return set_error(&model->last_error, "parameterMaskPose must be uint8 rank-1.");
  }
  if (parameter_mask_rigid.scalar_type != MHR_SCALAR_UINT8 || parameter_mask_rigid.shape != parameter_mask_pose.shape) {
    return set_error(&model->last_error, "parameterMaskRigid must match parameterMaskPose.");
  }
  if (parameter_mask_scaling.scalar_type != MHR_SCALAR_UINT8 || parameter_mask_scaling.shape != parameter_mask_pose.shape) {
    return set_error(&model->last_error, "parameterMaskScaling must match parameterMaskPose.");
  }
  if (base_mesh.scalar_type != MHR_SCALAR_FLOAT32 || base_mesh.shape.size() != 2 || base_mesh.shape[1] != 3) {
    return set_error(&model->last_error, "baseMesh must be float32 with shape [vertexCount, 3].");
  }
  if (identity_basis.scalar_type != MHR_SCALAR_FLOAT32 || identity_basis.shape.size() != 3 || identity_basis.shape[2] != 3) {
    return set_error(&model->last_error, "identityBasis must be float32 with shape [count, vertexCount, 3].");
  }
  if (expression_basis.scalar_type != MHR_SCALAR_FLOAT32 || expression_basis.shape.size() != 3 || expression_basis.shape[2] != 3) {
    return set_error(&model->last_error, "expressionBasis must be float32 with shape [count, vertexCount, 3].");
  }
  if (parameter_transform_row_ptr.scalar_type != MHR_SCALAR_UINT32 || parameter_transform_row_ptr.shape.size() != 1) {
    return set_error(&model->last_error, "parameterTransformRowPtr must be uint32 rank-1.");
  }
  if (parameter_transform_col_index.scalar_type != MHR_SCALAR_UINT32 || parameter_transform_col_index.shape.size() != 1) {
    return set_error(&model->last_error, "parameterTransformColIndex must be uint32 rank-1.");
  }
  if (parameter_transform_values.scalar_type != MHR_SCALAR_FLOAT32 || parameter_transform_values.shape != parameter_transform_col_index.shape) {
    return set_error(&model->last_error, "parameterTransformValues must match parameterTransformColIndex.");
  }
  if (pose_hidden_row_ptr.scalar_type != MHR_SCALAR_UINT32 || pose_hidden_row_ptr.shape.size() != 1) {
    return set_error(&model->last_error, "poseHiddenRowPtr must be uint32 rank-1.");
  }
  if (pose_hidden_feature_index.scalar_type != MHR_SCALAR_UINT32 || pose_hidden_feature_index.shape.size() != 1) {
    return set_error(&model->last_error, "poseHiddenFeatureIndex must be uint32 rank-1.");
  }
  if (pose_hidden_values.scalar_type != MHR_SCALAR_FLOAT32 || pose_hidden_values.shape != pose_hidden_feature_index.shape) {
    return set_error(&model->last_error, "poseHiddenValues must match poseHiddenFeatureIndex.");
  }
  if (corrective_col_ptr.scalar_type != MHR_SCALAR_UINT32 || corrective_col_ptr.shape.size() != 1) {
    return set_error(&model->last_error, "correctiveColPtr must be uint32 rank-1.");
  }
  if (corrective_row_index.scalar_type != MHR_SCALAR_UINT32 || corrective_row_index.shape.size() != 1) {
    return set_error(&model->last_error, "correctiveRowIndex must be uint32 rank-1.");
  }
  if (corrective_values.scalar_type != MHR_SCALAR_FLOAT32 || corrective_values.shape != corrective_row_index.shape) {
    return set_error(&model->last_error, "correctiveValues must match correctiveRowIndex.");
  }
  if (pose_block_feature_offsets.scalar_type != MHR_SCALAR_UINT32 || pose_block_feature_offsets.shape.size() != 1) {
    return set_error(&model->last_error, "poseBlockFeatureOffsets must be uint32 rank-1.");
  }
  if (pose_block_hidden_offsets.scalar_type != MHR_SCALAR_UINT32 || pose_block_hidden_offsets.shape.size() != 1) {
    return set_error(&model->last_error, "poseBlockHiddenOffsets must be uint32 rank-1.");
  }
  if (corrective_block_row_offsets.scalar_type != MHR_SCALAR_UINT32 || corrective_block_row_offsets.shape.size() != 1) {
    return set_error(&model->last_error, "correctiveBlockRowOffsets must be uint32 rank-1.");
  }
  if (corrective_block_row_index.scalar_type != MHR_SCALAR_UINT32 || corrective_block_row_index.shape.size() != 1) {
    return set_error(&model->last_error, "correctiveBlockRowIndex must be uint32 rank-1.");
  }

  model->counts.vertex_count = static_cast<uint32_t>(skinning_weights.shape[0]);
  model->counts.face_count = static_cast<uint32_t>(model->arrays.at("meshTopology").shape[0]);
  model->counts.max_influence_count = static_cast<uint32_t>(skinning_weights.shape[1]);
  model->counts.joint_count = static_cast<uint32_t>(joint_parents.shape[0]);
  model->counts.identity_count = static_cast<uint32_t>(identity_basis.shape[0]);
  model->counts.expression_count = static_cast<uint32_t>(expression_basis.shape[0]);
  model->counts.parameter_input_count = static_cast<uint32_t>(parameter_limits.shape[0]);
  model->counts.model_parameter_count =
      model->counts.parameter_input_count - model->counts.identity_count - model->counts.expression_count;
  if (model->counts.parameter_input_count <= model->counts.identity_count + model->counts.expression_count) {
    return set_error(&model->last_error, "parameterTransform input width is too small.");
  }
  if (base_mesh.shape[0] != skinning_weights.shape[0] ||
      identity_basis.shape[1] != base_mesh.shape[0] ||
      expression_basis.shape[1] != base_mesh.shape[0]) {
    return set_error(&model->last_error, "Base and basis vertex counts must match.");
  }
  if (rig_translation_offsets.shape[0] != joint_parents.shape[0] ||
      rig_prerotations.shape[0] != joint_parents.shape[0] ||
      inverse_bind_pose.shape[0] != joint_parents.shape[0]) {
    return set_error(&model->last_error, "Joint-shaped arrays must agree on jointCount.");
  }
  if (prefix_mul_level_offsets.shape[0] == 0U) {
    return set_error(&model->last_error, "prefixMulLevelOffsets must be non-empty.");
  }
  if (array_data<uint32_t>(prefix_mul_level_offsets)[prefix_mul_level_offsets.shape[0] - 1U] !=
      prefix_mul_source.shape[0]) {
    return set_error(&model->last_error, "prefixMulLevelOffsets terminal value must equal pair count.");
  }
  const uint32_t parameter_transform_row_count =
      static_cast<uint32_t>(parameter_transform_row_ptr.shape[0] - 1U);
  if (parameter_transform_row_count != model->counts.joint_count * 7U) {
    return set_error(&model->last_error, "parameterTransform rows must equal jointCount * 7.");
  }
  if (array_data<uint32_t>(parameter_transform_row_ptr)[parameter_transform_row_count] !=
      parameter_transform_col_index.shape[0]) {
    return set_error(&model->last_error, "parameterTransformRowPtr terminal value must equal nnz.");
  }
  model->counts.hidden_count = static_cast<uint32_t>(corrective_col_ptr.shape[0] - 1U);
  if (pose_hidden_row_ptr.shape[0] - 1U != corrective_col_ptr.shape[0] - 1U) {
    return set_error(&model->last_error, "poseHidden rows must equal hidden count.");
  }
  if (array_data<uint32_t>(pose_hidden_row_ptr)[pose_hidden_row_ptr.shape[0] - 1U] != pose_hidden_feature_index.shape[0]) {
    return set_error(&model->last_error, "poseHiddenRowPtr terminal value must equal nnz.");
  }
  if (array_data<uint32_t>(corrective_col_ptr)[corrective_col_ptr.shape[0] - 1U] != corrective_row_index.shape[0]) {
    return set_error(&model->last_error, "correctiveColPtr terminal value must equal nnz.");
  }
  if (pose_block_hidden_offsets.shape[0] == 0U) {
    model->pose_layout.pose_block_count = 0;
    model->counts.pose_feature_count =
        pose_hidden_feature_index.shape[0] == 0U
            ? 0U
            : max_u32_inclusive(
                      array_data<uint32_t>(pose_hidden_feature_index),
                      static_cast<uint32_t>(pose_hidden_feature_index.shape[0])) +
                  1U;
  } else {
    model->pose_layout.pose_block_count = static_cast<uint32_t>(pose_block_hidden_offsets.shape[0] - 1U);
    if (pose_block_feature_offsets.shape[0] != pose_block_hidden_offsets.shape[0] ||
        corrective_block_row_offsets.shape[0] != pose_block_hidden_offsets.shape[0]) {
      return set_error(&model->last_error, "Pose block offset arrays must agree.");
    }
    if (array_data<uint32_t>(pose_block_hidden_offsets)[model->pose_layout.pose_block_count] != model->counts.hidden_count) {
      return set_error(&model->last_error, "poseBlockHiddenOffsets terminal value must equal hidden count.");
    }
    model->counts.pose_feature_count =
        array_data<uint32_t>(pose_block_feature_offsets)[model->pose_layout.pose_block_count];
  }

  model->base_mesh = array_data<float>(base_mesh);
  model->identity_basis = array_data<float>(identity_basis);
  model->expression_basis = array_data<float>(expression_basis);
  model->rig_translation_offsets = array_data<float>(rig_translation_offsets);
  model->rig_prerotations = array_data<float>(rig_prerotations);
  model->inverse_bind_pose = array_data<float>(inverse_bind_pose);
  model->skinning_weights = array_data<float>(skinning_weights);
  model->skinning_indices = array_data<uint32_t>(skinning_indices);
  model->prefix_mul_level_offsets = array_data<uint32_t>(prefix_mul_level_offsets);
  model->prefix_mul_source = array_data<uint32_t>(prefix_mul_source);
  model->prefix_mul_target = array_data<uint32_t>(prefix_mul_target);
  model->pose_block_feature_offsets = array_data<uint32_t>(pose_block_feature_offsets);
  model->pose_block_hidden_offsets = array_data<uint32_t>(pose_block_hidden_offsets);
  model->corrective_block_row_offsets = array_data<uint32_t>(corrective_block_row_offsets);
  model->corrective_block_row_index = array_data<uint32_t>(corrective_block_row_index);
  model->joint_parents = array_data<int32_t>(joint_parents);
  model->prefix_mul_level_count = static_cast<uint32_t>(prefix_mul_level_offsets.shape[0] - 1U);
  model->prefix_mul_pair_count = static_cast<uint32_t>(prefix_mul_source.shape[0]);
  if (const auto dense_it = model->arrays.find("correctiveDenseFull");
      dense_it != model->arrays.end()) {
    const BundleArray& corrective_dense_full = dense_it->second;
    if (corrective_dense_full.scalar_type != MHR_SCALAR_FLOAT32 ||
        corrective_dense_full.shape.size() != 2 ||
        corrective_dense_full.shape[0] != static_cast<uint64_t>(model->counts.vertex_count) * 3U ||
        corrective_dense_full.shape[1] != model->counts.hidden_count) {
      return set_error(&model->last_error, "correctiveDenseFull shape does not match counts.");
    }
    model->pose_corrective_stage2_dense = array_data<float>(corrective_dense_full);
  } else {
    model->pose_corrective_stage2_dense = nullptr;
  }

  return true;
}

bool compile_model(CompiledModel* model, const MhrBundleView& bundle_view) {
  if (!validate_bundle(model, bundle_view)) {
    return false;
  }
  const BundleArray& parameter_transform_row_ptr = model->arrays.at("parameterTransformRowPtr");
  const BundleArray& parameter_transform_col_index = model->arrays.at("parameterTransformColIndex");
  const BundleArray& parameter_transform_values = model->arrays.at("parameterTransformValues");
  const BundleArray& pose_hidden_row_ptr = model->arrays.at("poseHiddenRowPtr");
  const BundleArray& pose_hidden_feature_index = model->arrays.at("poseHiddenFeatureIndex");
  const BundleArray& pose_hidden_values = model->arrays.at("poseHiddenValues");
  const BundleArray& corrective_col_ptr = model->arrays.at("correctiveColPtr");
  const BundleArray& corrective_row_index = model->arrays.at("correctiveRowIndex");
  const BundleArray& corrective_values = model->arrays.at("correctiveValues");

  model->parameter_transform.row_ptr.assign(
      array_data<uint32_t>(parameter_transform_row_ptr),
      array_data<uint32_t>(parameter_transform_row_ptr) + parameter_transform_row_ptr.shape[0]);
  model->parameter_transform.col_index.assign(
      array_data<uint32_t>(parameter_transform_col_index),
      array_data<uint32_t>(parameter_transform_col_index) + parameter_transform_col_index.shape[0]);
  model->parameter_transform.values.assign(
      array_data<float>(parameter_transform_values),
      array_data<float>(parameter_transform_values) + parameter_transform_values.shape[0]);
  model->parameter_transform.summary = summarize_csr(
      model->parameter_transform.row_ptr.data(),
      model->parameter_transform.col_index.data(),
      static_cast<uint32_t>(parameter_transform_row_ptr.shape[0] - 1U),
      model->counts.parameter_input_count);

  model->pose_corrective_stage1.row_ptr.assign(
      array_data<uint32_t>(pose_hidden_row_ptr),
      array_data<uint32_t>(pose_hidden_row_ptr) + pose_hidden_row_ptr.shape[0]);
  model->pose_corrective_stage1.col_index.assign(
      array_data<uint32_t>(pose_hidden_feature_index),
      array_data<uint32_t>(pose_hidden_feature_index) + pose_hidden_feature_index.shape[0]);
  model->pose_corrective_stage1.values.assign(
      array_data<float>(pose_hidden_values),
      array_data<float>(pose_hidden_values) + pose_hidden_values.shape[0]);
  model->pose_corrective_stage1.summary = summarize_csr(
      model->pose_corrective_stage1.row_ptr.data(),
      model->pose_corrective_stage1.col_index.data(),
      model->counts.hidden_count,
      model->counts.pose_feature_count);

  model->pose_corrective_stage2.col_ptr.assign(
      array_data<uint32_t>(corrective_col_ptr),
      array_data<uint32_t>(corrective_col_ptr) + corrective_col_ptr.shape[0]);
  model->pose_corrective_stage2.row_index.assign(
      array_data<uint32_t>(corrective_row_index),
      array_data<uint32_t>(corrective_row_index) + corrective_row_index.shape[0]);
  model->pose_corrective_stage2.values.assign(
      array_data<float>(corrective_values),
      array_data<float>(corrective_values) + corrective_values.shape[0]);
  model->pose_corrective_stage2.summary = summarize_csc(
      model->pose_corrective_stage2.col_ptr.data(),
      model->pose_corrective_stage2.row_index.data(),
      model->counts.vertex_count * 3U,
      model->counts.hidden_count);
  return true;
}

void assign_sparse_stats(const SparseMatrixSummary& summary, MhrSparseMatrixStats* stats) {
  if (stats == nullptr) {
    return;
  }
  stats->rows = summary.rows;
  stats->columns = summary.columns;
  stats->nnz = summary.nnz;
  stats->exact_zero_fraction = summary.exact_zero_fraction;
  stats->max_row_nnz = summary.max_row_nnz;
  stats->max_column_nnz = summary.max_column_nnz;
}

}  // namespace

struct MhrModel {
  CompiledModel impl;
};

struct MhrData {
  WorkspaceData impl;
};

MhrModel* mhr_model_load_ir(const MhrBundleView* bundle_view) {
  if (bundle_view == nullptr) {
    return nullptr;
  }
  MhrModel* model = new MhrModel{};
  if (!compile_model(&model->impl, *bundle_view)) {
    return model;
  }
  return model;
}

void mhr_model_destroy(MhrModel* model) { delete model; }

const char* mhr_model_last_error(const MhrModel* model) {
  if (model == nullptr) {
    return "Model is null.";
  }
  return model->impl.last_error.c_str();
}

int mhr_model_get_counts(const MhrModel* model, MhrModelCounts* counts) {
  if (model == nullptr || counts == nullptr) {
    return 0;
  }
  *counts = model->impl.counts;
  return 1;
}

int mhr_model_get_parameter_transform_stats(const MhrModel* model, MhrSparseMatrixStats* stats) {
  if (model == nullptr || stats == nullptr) {
    return 0;
  }
  assign_sparse_stats(model->impl.parameter_transform.summary, stats);
  return 1;
}

int mhr_model_get_pose_corrective_stats(
    const MhrModel* model,
    MhrSparseMatrixStats* stage1_stats,
    MhrSparseMatrixStats* stage2_stats) {
  if (model == nullptr || stage1_stats == nullptr || stage2_stats == nullptr) {
    return 0;
  }
  assign_sparse_stats(model->impl.pose_corrective_stage1.summary, stage1_stats);
  assign_sparse_stats(model->impl.pose_corrective_stage2.summary, stage2_stats);
  return 1;
}

int mhr_model_get_pose_block_layout(const MhrModel* model, MhrPoseBlockLayout* layout) {
  if (model == nullptr || layout == nullptr) {
    return 0;
  }
  *layout = model->impl.pose_layout;
  return 1;
}

MhrData* mhr_data_create(const MhrModel* model) {
  if (model == nullptr) {
    return nullptr;
  }
  MhrData* data = new MhrData{};
  const MhrModelCounts& counts = model->impl.counts;
  data->impl.model_parameters.assign(counts.model_parameter_count, 0.0f);
  data->impl.identity.assign(counts.identity_count, 0.0f);
  data->impl.expression.assign(counts.expression_count, 0.0f);
  data->impl.parameter_inputs.assign(counts.parameter_input_count, 0.0f);
  data->impl.joint_parameters_fp64.assign(static_cast<size_t>(counts.joint_count) * 7U, 0.0);
  data->impl.world_transforms_fp64.assign(counts.joint_count, Transform{});
  data->impl.joint_parameters.assign(static_cast<size_t>(counts.joint_count) * 7U, 0.0f);
  data->impl.local_transforms.assign(static_cast<size_t>(counts.joint_count) * 8U, 0.0f);
  data->impl.global_transforms.assign(static_cast<size_t>(counts.joint_count) * 8U, 0.0f);
  data->impl.skin_transforms.assign(static_cast<size_t>(counts.joint_count) * 8U, 0.0f);
  data->impl.pose_features.assign(counts.pose_feature_count, 0.0f);
  data->impl.hidden.assign(counts.hidden_count, 0.0f);
  data->impl.corrective_delta.assign(static_cast<size_t>(counts.vertex_count) * 3U, 0.0f);
  data->impl.rest_vertices_pre_corrective.assign(static_cast<size_t>(counts.vertex_count) * 3U, 0.0f);
  data->impl.rest_vertices.assign(static_cast<size_t>(counts.vertex_count) * 3U, 0.0f);
  data->impl.output_vertices.assign(static_cast<size_t>(counts.vertex_count) * 3U, 0.0f);
  data->impl.skeleton.assign(static_cast<size_t>(counts.joint_count) * 8U, 0.0f);
  data->impl.derived.assign(kDerivedValueCount, 0.0f);
  data->impl.cache_available = false;
  data->impl.evaluated = false;
  data->impl.derived_valid = false;
  data->impl.model_parameters_dirty = true;
  data->impl.identity_dirty = true;
  data->impl.expression_dirty = true;
  return data;
}

void mhr_data_destroy(MhrData* data) { delete data; }

const char* mhr_data_last_error(const MhrData* data) {
  if (data == nullptr) {
    return "Data is null.";
  }
  return data->impl.last_error.c_str();
}

int mhr_data_reset(const MhrModel* model, MhrData* data) {
  if (model == nullptr || data == nullptr) {
    return 0;
  }
  std::fill(data->impl.model_parameters.begin(), data->impl.model_parameters.end(), 0.0f);
  std::fill(data->impl.identity.begin(), data->impl.identity.end(), 0.0f);
  std::fill(data->impl.expression.begin(), data->impl.expression.end(), 0.0f);
  std::fill(data->impl.parameter_inputs.begin(), data->impl.parameter_inputs.end(), 0.0f);
  std::fill(data->impl.joint_parameters_fp64.begin(), data->impl.joint_parameters_fp64.end(), 0.0);
  std::fill(data->impl.world_transforms_fp64.begin(), data->impl.world_transforms_fp64.end(), Transform{});
  std::fill(data->impl.joint_parameters.begin(), data->impl.joint_parameters.end(), 0.0f);
  std::fill(data->impl.local_transforms.begin(), data->impl.local_transforms.end(), 0.0f);
  std::fill(data->impl.global_transforms.begin(), data->impl.global_transforms.end(), 0.0f);
  std::fill(data->impl.skin_transforms.begin(), data->impl.skin_transforms.end(), 0.0f);
  std::fill(data->impl.pose_features.begin(), data->impl.pose_features.end(), 0.0f);
  std::fill(data->impl.hidden.begin(), data->impl.hidden.end(), 0.0f);
  std::fill(data->impl.corrective_delta.begin(), data->impl.corrective_delta.end(), 0.0f);
  std::fill(data->impl.rest_vertices_pre_corrective.begin(), data->impl.rest_vertices_pre_corrective.end(), 0.0f);
  std::fill(data->impl.rest_vertices.begin(), data->impl.rest_vertices.end(), 0.0f);
  std::fill(data->impl.output_vertices.begin(), data->impl.output_vertices.end(), 0.0f);
  std::fill(data->impl.skeleton.begin(), data->impl.skeleton.end(), 0.0f);
  std::fill(data->impl.derived.begin(), data->impl.derived.end(), 0.0f);
  data->impl.timing = {};
  data->impl.cache_available = false;
  data->impl.evaluated = false;
  data->impl.derived_valid = false;
  data->impl.model_parameters_dirty = true;
  data->impl.identity_dirty = true;
  data->impl.expression_dirty = true;
  data->impl.last_error.clear();
  return 1;
}

int mhr_data_get_workspace_counts(const MhrData* data, MhrDataWorkspaceCounts* counts) {
  if (data == nullptr || counts == nullptr) {
    return 0;
  }
  counts->model_parameter_count = static_cast<uint32_t>(data->impl.model_parameters.size());
  counts->identity_count = static_cast<uint32_t>(data->impl.identity.size());
  counts->expression_count = static_cast<uint32_t>(data->impl.expression.size());
  counts->joint_parameter_count = static_cast<uint32_t>(data->impl.joint_parameters.size());
  counts->local_transform_count = static_cast<uint32_t>(data->impl.local_transforms.size());
  counts->global_transform_count = static_cast<uint32_t>(data->impl.global_transforms.size());
  counts->skin_transform_count = static_cast<uint32_t>(data->impl.skin_transforms.size());
  counts->pose_feature_count = static_cast<uint32_t>(data->impl.pose_features.size());
  counts->hidden_count = static_cast<uint32_t>(data->impl.hidden.size());
  counts->corrective_delta_count = static_cast<uint32_t>(data->impl.corrective_delta.size());
  counts->rest_pre_corrective_count = static_cast<uint32_t>(data->impl.rest_vertices_pre_corrective.size());
  counts->rest_vertex_count = static_cast<uint32_t>(data->impl.rest_vertices.size());
  counts->output_vertex_count = static_cast<uint32_t>(data->impl.output_vertices.size());
  counts->skeleton_count = static_cast<uint32_t>(data->impl.skeleton.size());
  counts->derived_count = static_cast<uint32_t>(data->impl.derived.size());
  return 1;
}

int mhr_data_set_model_parameters(
    const MhrModel* model,
    MhrData* data,
    const float* values,
    uint32_t count) {
  if (model == nullptr || data == nullptr || values == nullptr) {
    return 0;
  }
  if (count != model->impl.counts.model_parameter_count) {
    data->impl.last_error = "Model parameter count does not match model.";
    return 0;
  }
  if (float_vector_matches(data->impl.model_parameters, values, count)) {
    return 1;
  }
  data->impl.model_parameters.assign(values, values + count);
  data->impl.model_parameters_dirty = true;
  data->impl.evaluated = false;
  data->impl.derived_valid = false;
  return 1;
}

int mhr_data_set_identity(
    const MhrModel* model,
    MhrData* data,
    const float* values,
    uint32_t count) {
  if (model == nullptr || data == nullptr || values == nullptr) {
    return 0;
  }
  if (count != model->impl.counts.identity_count) {
    data->impl.last_error = "Identity count does not match model.";
    return 0;
  }
  if (float_vector_matches(data->impl.identity, values, count)) {
    return 1;
  }
  data->impl.identity.assign(values, values + count);
  data->impl.identity_dirty = true;
  data->impl.evaluated = false;
  data->impl.derived_valid = false;
  return 1;
}

int mhr_data_set_expression(
    const MhrModel* model,
    MhrData* data,
    const float* values,
    uint32_t count) {
  if (model == nullptr || data == nullptr || values == nullptr) {
    return 0;
  }
  if (count != model->impl.counts.expression_count) {
    data->impl.last_error = "Expression count does not match model.";
    return 0;
  }
  if (float_vector_matches(data->impl.expression, values, count)) {
    return 1;
  }
  data->impl.expression.assign(values, values + count);
  data->impl.expression_dirty = true;
  data->impl.evaluated = false;
  data->impl.derived_valid = false;
  return 1;
}

int mhr_forward(const MhrModel* model, MhrData* data, uint32_t flags) {
  if (model == nullptr || data == nullptr) {
    return 0;
  }

  auto& impl = data->impl;
  const auto& compiled = model->impl;
  const MhrModelCounts& counts = compiled.counts;
  const auto evaluate_start = SteadyClock::now();
  const bool skip_derived = (flags & MHR_FORWARD_SKIP_DERIVED) != 0U;
  const bool exact_linear_algebra = (flags & MHR_FORWARD_EXACT_LINEAR_ALGEBRA) != 0U;

  impl.timing = {};

  const bool cache_available = impl.cache_available;
  const bool model_dirty = impl.model_parameters_dirty;
  const bool identity_dirty = impl.identity_dirty;
  const bool expression_dirty = impl.expression_dirty;

  const bool parameter_decode_dirty = !cache_available || model_dirty || identity_dirty;
  const bool joint_world_dirty = parameter_decode_dirty;
  const bool surface_morph_dirty = !cache_available || identity_dirty || expression_dirty;
  const bool pose_features_dirty = !cache_available || joint_world_dirty;
  const bool corrective_stage1_dirty = !cache_available || pose_features_dirty;

  std::vector<float> previous_hidden;
  if (cache_available && corrective_stage1_dirty) {
    previous_hidden = impl.hidden;
  }

  std::vector<float> previous_pose_features;
  if (cache_available && pose_features_dirty && compiled.pose_layout.pose_block_count > 0U) {
    previous_pose_features = impl.pose_features;
  }

  if (parameter_decode_dirty) {
    const auto stage_start = SteadyClock::now();
    std::copy(
        impl.model_parameters.begin(),
        impl.model_parameters.end(),
        impl.parameter_inputs.begin());
    std::copy(
        impl.identity.begin(),
        impl.identity.end(),
        impl.parameter_inputs.begin() + counts.model_parameter_count);

    bool used_exact_parameter_decode = false;
#ifdef _WIN32
    if (exact_linear_algebra) {
      const DenseMatrix& parameter_transform_dense = parameter_transform_dense_matrix(compiled);
      used_exact_parameter_decode = exact_sgemv(
          static_cast<int>(parameter_transform_dense.rows),
          static_cast<int>(parameter_transform_dense.columns),
          parameter_transform_dense.values.data(),
          impl.parameter_inputs.data(),
          impl.joint_parameters.data());
    }
#endif
    if (!used_exact_parameter_decode) {
      for (uint32_t row = 0; row < compiled.parameter_transform.summary.rows; ++row) {
        double accum = 0.0;
        const uint32_t start = compiled.parameter_transform.row_ptr[row];
        const uint32_t end = compiled.parameter_transform.row_ptr[row + 1];
        for (uint32_t cursor = start; cursor < end; ++cursor) {
          const uint32_t column = compiled.parameter_transform.col_index[cursor];
          accum += static_cast<double>(compiled.parameter_transform.values[cursor]) *
                   static_cast<double>(impl.parameter_inputs[column]);
        }
        impl.joint_parameters[row] = static_cast<float>(accum);
      }
    }
    for (uint32_t row = 0; row < compiled.parameter_transform.summary.rows; ++row) {
      impl.joint_parameters_fp64[row] = static_cast<double>(impl.joint_parameters[row]);
    }
    impl.timing.parameter_decode_ms = elapsed_ms(stage_start, SteadyClock::now());
  }

  if (joint_world_dirty) {
    const auto stage_start = SteadyClock::now();
    for (uint32_t joint_index = 0; joint_index < counts.joint_count; ++joint_index) {
      const float* joint_values = impl.joint_parameters.data() + static_cast<size_t>(joint_index) * 7U;
      const float* rig_translation = compiled.rig_translation_offsets + static_cast<size_t>(joint_index) * 3U;
      const float* rig_prerotation = compiled.rig_prerotations + static_cast<size_t>(joint_index) * 4U;
      const Quatf local_rotation = quat_multiply_assume_normalizedf(
          Quatf{rig_prerotation[0], rig_prerotation[1], rig_prerotation[2], rig_prerotation[3]},
          euler_xyz_quatf(joint_values[3], joint_values[4], joint_values[5]));
      Transform local_transform;
      local_transform.translation = Vec3{
          rig_translation[0] + joint_values[0],
          rig_translation[1] + joint_values[1],
          rig_translation[2] + joint_values[2],
      };
      local_transform.rotation = Quat{
          static_cast<double>(local_rotation.x),
          static_cast<double>(local_rotation.y),
          static_cast<double>(local_rotation.z),
          static_cast<double>(local_rotation.w),
      };
      local_transform.scale = std::exp2(joint_values[6]);
      write_transform_tuple(
          local_transform,
          impl.local_transforms.data() + static_cast<size_t>(joint_index) * 8U);
      impl.world_transforms_fp64[static_cast<size_t>(joint_index)] = local_transform;
    }

    for (uint32_t level = 0; level < compiled.prefix_mul_level_count; ++level) {
      const uint32_t start = compiled.prefix_mul_level_offsets[level];
      const uint32_t end = compiled.prefix_mul_level_offsets[level + 1U];
      for (uint32_t cursor = start; cursor < end; ++cursor) {
        const uint32_t source = compiled.prefix_mul_source[cursor];
        const uint32_t target = compiled.prefix_mul_target[cursor];
        impl.world_transforms_fp64[static_cast<size_t>(source)] = multiply_skel_state(
            impl.world_transforms_fp64[static_cast<size_t>(target)],
            impl.world_transforms_fp64[static_cast<size_t>(source)]);
      }
    }

    for (uint32_t joint_index = 0; joint_index < counts.joint_count; ++joint_index) {
      const Transform& world_transform = impl.world_transforms_fp64[static_cast<size_t>(joint_index)];
      write_transform_tuple(
          world_transform,
          impl.global_transforms.data() + static_cast<size_t>(joint_index) * 8U);
      write_transform_tuple(
          world_transform,
          impl.skeleton.data() + static_cast<size_t>(joint_index) * 8U);
    }
    impl.timing.joint_world_transforms_ms = elapsed_ms(stage_start, SteadyClock::now());
  }

  const size_t vertex_value_count = static_cast<size_t>(counts.vertex_count) * 3U;
  if (surface_morph_dirty) {
    const auto stage_start = SteadyClock::now();
    const std::vector<ActiveBasisTerm> active_identity = build_active_basis_terms(
        compiled.identity_basis,
        impl.identity,
        vertex_value_count);
    const std::vector<ActiveBasisTerm> active_expression = build_active_basis_terms(
        compiled.expression_basis,
        impl.expression,
        vertex_value_count);
    compose_surface_morph_exact(
        compiled.base_mesh,
        active_identity,
        active_expression,
        &impl.rest_vertices_pre_corrective);
    impl.timing.surface_morph_ms = elapsed_ms(stage_start, SteadyClock::now());
  }

  if (pose_features_dirty) {
    const auto stage_start = SteadyClock::now();
    const uint32_t pose_joint_count =
        std::min(counts.pose_feature_count / 6U,
                 counts.joint_count > 2U ? counts.joint_count - 2U : 0U);
    for (uint32_t joint_offset = 0; joint_offset < pose_joint_count; ++joint_offset) {
      const uint32_t joint_index = joint_offset + 2U;
      const float* joint_values = impl.joint_parameters.data() + static_cast<size_t>(joint_index) * 7U;
      const float rx = joint_values[3];
      const float ry = joint_values[4];
      const float rz = joint_values[5];
      float sx;
      float sy;
      float sz;
      float cx;
      float cy;
      float cz;
#ifdef _WIN32
      float sin_values[3];
      float cos_values[3];
      if (exact_sincos3(rx, ry, rz, sin_values, cos_values)) {
        sx = sin_values[0];
        sy = sin_values[1];
        sz = sin_values[2];
        cx = cos_values[0];
        cy = cos_values[1];
        cz = cos_values[2];
      } else
#endif
      {
        cx = std::cos(rx);
        cy = std::cos(ry);
        cz = std::cos(rz);
        sx = std::sin(rx);
        sy = std::sin(ry);
        sz = std::sin(rz);
      }
      const size_t offset = static_cast<size_t>(joint_offset) * 6U;
      impl.pose_features[offset + 0] = cy * cz - 1.0f;
      impl.pose_features[offset + 1] = cy * sz;
      impl.pose_features[offset + 2] = -sy;
      impl.pose_features[offset + 3] = -cx * sz + sx * sy * cz;
      impl.pose_features[offset + 4] = cx * cz + sx * sy * sz - 1.0f;
      impl.pose_features[offset + 5] = sx * cy;
    }
    impl.timing.pose_features_ms = elapsed_ms(stage_start, SteadyClock::now());
  }

  bool corrective_stage2_dirty = !cache_available || corrective_stage1_dirty;
  bool corrective_delta_changed = false;
  std::vector<uint32_t> dirty_pose_blocks;

  if (corrective_stage1_dirty) {
    const auto stage_start = SteadyClock::now();
    const uint32_t block_count = compiled.pose_layout.pose_block_count;
    bool run_full_stage1 = !cache_available || block_count == 0U || previous_pose_features.empty();
    if (!run_full_stage1) {
      dirty_pose_blocks.reserve(block_count);
      for (uint32_t block_index = 0; block_index < block_count; ++block_index) {
        const uint32_t feature_start = compiled.pose_block_feature_offsets[block_index];
        const uint32_t feature_end = compiled.pose_block_feature_offsets[block_index + 1U];
        const float* previous_begin =
            previous_pose_features.data() + static_cast<size_t>(feature_start);
        const float* previous_end =
            previous_pose_features.data() + static_cast<size_t>(feature_end);
        const float* current_begin =
            impl.pose_features.data() + static_cast<size_t>(feature_start);
        if (!std::equal(previous_begin, previous_end, current_begin)) {
          dirty_pose_blocks.push_back(block_index);
        }
      }
      run_full_stage1 = dirty_pose_blocks.size() == block_count;
    } else {
      dirty_pose_blocks.assign(block_count, 0U);
      for (uint32_t block_index = 0; block_index < block_count; ++block_index) {
        dirty_pose_blocks[block_index] = block_index;
      }
    }

    if (run_full_stage1) {
      bool used_exact_stage1 = false;
#ifdef _WIN32
      if (exact_linear_algebra) {
        const DenseMatrix& pose_corrective_stage1_dense =
            pose_corrective_stage1_dense_matrix(compiled);
        used_exact_stage1 = exact_sgemv(
            static_cast<int>(pose_corrective_stage1_dense.rows),
            static_cast<int>(pose_corrective_stage1_dense.columns),
            pose_corrective_stage1_dense.values.data(),
            impl.pose_features.data(),
            impl.hidden.data());
      }
#endif
      if (!used_exact_stage1) {
        for (uint32_t row = 0; row < compiled.pose_corrective_stage1.summary.rows; ++row) {
          float accum = 0.0f;
          const uint32_t start = compiled.pose_corrective_stage1.row_ptr[row];
          const uint32_t end = compiled.pose_corrective_stage1.row_ptr[row + 1];
          for (uint32_t cursor = start; cursor < end; ++cursor) {
            const uint32_t feature_index = compiled.pose_corrective_stage1.col_index[cursor];
            accum +=
                compiled.pose_corrective_stage1.values[cursor] * impl.pose_features[feature_index];
          }
          impl.hidden[row] = std::max(accum, 0.0f);
        }
      } else {
        for (float& value : impl.hidden) {
          value = std::max(value, 0.0f);
        }
      }
    } else if (!dirty_pose_blocks.empty()) {
      for (const uint32_t block_index : dirty_pose_blocks) {
        const uint32_t row_start = compiled.pose_block_hidden_offsets[block_index];
        const uint32_t row_end = compiled.pose_block_hidden_offsets[block_index + 1U];
        for (uint32_t row = row_start; row < row_end; ++row) {
          float accum = 0.0f;
          const uint32_t start = compiled.pose_corrective_stage1.row_ptr[row];
          const uint32_t end = compiled.pose_corrective_stage1.row_ptr[row + 1];
          for (uint32_t cursor = start; cursor < end; ++cursor) {
            const uint32_t feature_index = compiled.pose_corrective_stage1.col_index[cursor];
            accum +=
                compiled.pose_corrective_stage1.values[cursor] * impl.pose_features[feature_index];
          }
          impl.hidden[row] = std::max(accum, 0.0f);
        }
      }
    } else {
      corrective_stage2_dirty = false;
    }

    impl.timing.corrective_stage1_ms = elapsed_ms(stage_start, SteadyClock::now());
  }

  std::vector<uint32_t> touched_corrective_rows;
  if (corrective_stage2_dirty) {
    const auto stage_start = SteadyClock::now();
    bool run_full_stage2 = !cache_available || previous_hidden.empty();
    if (run_full_stage2) {
      corrective_delta_changed = true;
      bool used_exact_stage2 = false;
#ifdef _WIN32
      if (exact_linear_algebra && compiled.pose_corrective_stage2_dense != nullptr) {
        used_exact_stage2 = exact_sgemv(
            static_cast<int>(counts.vertex_count * 3U),
            static_cast<int>(counts.hidden_count),
            compiled.pose_corrective_stage2_dense,
            impl.hidden.data(),
            impl.corrective_delta.data());
      }
#endif
      if (!used_exact_stage2) {
        std::fill(impl.corrective_delta.begin(), impl.corrective_delta.end(), 0.0f);
        for (uint32_t hidden_index = 0; hidden_index < compiled.pose_corrective_stage2.summary.columns;
             ++hidden_index) {
          const float hidden_value = impl.hidden[hidden_index];
          if (hidden_value == 0.0f) {
            continue;
          }
          const uint32_t start = compiled.pose_corrective_stage2.col_ptr[hidden_index];
          const uint32_t end = compiled.pose_corrective_stage2.col_ptr[hidden_index + 1];
          for (uint32_t cursor = start; cursor < end; ++cursor) {
            impl.corrective_delta[compiled.pose_corrective_stage2.row_index[cursor]] +=
                compiled.pose_corrective_stage2.values[cursor] * hidden_value;
          }
        }
      }
    } else {
      std::vector<uint32_t> dirty_hidden_indices;
      dirty_hidden_indices.reserve(counts.hidden_count);
      for (uint32_t hidden_index = 0; hidden_index < counts.hidden_count; ++hidden_index) {
        if (previous_hidden[hidden_index] != impl.hidden[hidden_index]) {
          dirty_hidden_indices.push_back(hidden_index);
        }
      }

      if (!dirty_hidden_indices.empty()) {
        run_full_stage2 =
            dirty_hidden_indices.size() > std::max<uint32_t>(1U, counts.hidden_count / 3U);
        if (run_full_stage2) {
          corrective_delta_changed = true;
          bool used_exact_stage2 = false;
#ifdef _WIN32
          if (exact_linear_algebra && compiled.pose_corrective_stage2_dense != nullptr) {
            used_exact_stage2 = exact_sgemv(
                static_cast<int>(counts.vertex_count * 3U),
                static_cast<int>(counts.hidden_count),
                compiled.pose_corrective_stage2_dense,
                impl.hidden.data(),
                impl.corrective_delta.data());
          }
#endif
          if (!used_exact_stage2) {
            std::fill(impl.corrective_delta.begin(), impl.corrective_delta.end(), 0.0f);
            for (uint32_t hidden_index = 0;
                 hidden_index < compiled.pose_corrective_stage2.summary.columns;
                 ++hidden_index) {
              const float hidden_value = impl.hidden[hidden_index];
              if (hidden_value == 0.0f) {
                continue;
              }
              const uint32_t start = compiled.pose_corrective_stage2.col_ptr[hidden_index];
              const uint32_t end = compiled.pose_corrective_stage2.col_ptr[hidden_index + 1];
              for (uint32_t cursor = start; cursor < end; ++cursor) {
                impl.corrective_delta[compiled.pose_corrective_stage2.row_index[cursor]] +=
                    compiled.pose_corrective_stage2.values[cursor] * hidden_value;
              }
            }
          }
        } else {
          corrective_delta_changed = true;
          std::vector<uint8_t> touched_row_flags(vertex_value_count, 0U);
          for (const uint32_t hidden_index : dirty_hidden_indices) {
            const float delta = impl.hidden[hidden_index] - previous_hidden[hidden_index];
            const uint32_t start = compiled.pose_corrective_stage2.col_ptr[hidden_index];
            const uint32_t end = compiled.pose_corrective_stage2.col_ptr[hidden_index + 1];
            for (uint32_t cursor = start; cursor < end; ++cursor) {
              impl.corrective_delta[compiled.pose_corrective_stage2.row_index[cursor]] +=
                  compiled.pose_corrective_stage2.values[cursor] * delta;
            }
            if (compiled.pose_layout.pose_block_count > 0U) {
              const uint32_t block_index = find_pose_block_for_hidden_index(
                  compiled.pose_block_hidden_offsets,
                  compiled.pose_layout.pose_block_count,
                  hidden_index);
              const uint32_t row_start = compiled.corrective_block_row_offsets[block_index];
              const uint32_t row_end = compiled.corrective_block_row_offsets[block_index + 1U];
              for (uint32_t row_cursor = row_start; row_cursor < row_end; ++row_cursor) {
                const uint32_t output_row = compiled.corrective_block_row_index[row_cursor];
                if (touched_row_flags[output_row] == 0U) {
                  touched_row_flags[output_row] = 1U;
                  touched_corrective_rows.push_back(output_row);
                }
              }
            }
          }
        }
      }
    }

    impl.timing.corrective_stage2_ms = elapsed_ms(stage_start, SteadyClock::now());
  }

  bool rest_vertices_dirty = !cache_available;
  if (surface_morph_dirty) {
    compose_rest_vertices(
        impl.rest_vertices_pre_corrective,
        impl.corrective_delta,
        &impl.rest_vertices);
    rest_vertices_dirty = true;
  } else if (corrective_delta_changed) {
    if (touched_corrective_rows.empty()) {
      compose_rest_vertices(
          impl.rest_vertices_pre_corrective,
          impl.corrective_delta,
          &impl.rest_vertices);
    } else {
      compose_rest_vertices_rows(
          impl.rest_vertices_pre_corrective,
          impl.corrective_delta,
          touched_corrective_rows,
          &impl.rest_vertices);
    }
    rest_vertices_dirty = true;
  }

  const bool skinning_dirty = !cache_available || joint_world_dirty || rest_vertices_dirty;
  if (skinning_dirty) {
    const auto stage_start = SteadyClock::now();
    if (joint_world_dirty || !cache_available) {
      for (uint32_t joint_index = 0; joint_index < counts.joint_count; ++joint_index) {
        const float* global_state = impl.global_transforms.data() + static_cast<size_t>(joint_index) * 8U;
        const float* inverse_bind_state = compiled.inverse_bind_pose + static_cast<size_t>(joint_index) * 8U;
        const Quatf parent_rotation = normalize_quatf(
            Quatf{global_state[3], global_state[4], global_state[5], global_state[6]});
        const Quatf local_rotation = normalize_quatf(
            Quatf{
                inverse_bind_state[3],
                inverse_bind_state[4],
                inverse_bind_state[5],
                inverse_bind_state[6]});
        const Vec3f rotated = rotate_vec_assume_normalizedf(
            parent_rotation,
            Vec3f{inverse_bind_state[0], inverse_bind_state[1], inverse_bind_state[2]});
        const size_t skin_offset = static_cast<size_t>(joint_index) * 8U;
        impl.skin_transforms[skin_offset + 0] = global_state[0] + global_state[7] * rotated.x;
        impl.skin_transforms[skin_offset + 1] = global_state[1] + global_state[7] * rotated.y;
        impl.skin_transforms[skin_offset + 2] = global_state[2] + global_state[7] * rotated.z;
        const Quatf joint_rotation = quat_multiply_assume_normalizedf(parent_rotation, local_rotation);
        impl.skin_transforms[skin_offset + 3] = joint_rotation.x;
        impl.skin_transforms[skin_offset + 4] = joint_rotation.y;
        impl.skin_transforms[skin_offset + 5] = joint_rotation.z;
        impl.skin_transforms[skin_offset + 6] = joint_rotation.w;
        impl.skin_transforms[skin_offset + 7] = global_state[7] * inverse_bind_state[7];
      }
    }

    for (uint32_t vertex_index = 0; vertex_index < counts.vertex_count; ++vertex_index) {
      const size_t base_offset = static_cast<size_t>(vertex_index) * 3U;
      const Vec3f rest_point{
          impl.rest_vertices[base_offset + 0],
          impl.rest_vertices[base_offset + 1],
          impl.rest_vertices[base_offset + 2],
      };
      Vec3f skinned{};
      for (uint32_t influence_index = 0; influence_index < counts.max_influence_count;
           ++influence_index) {
        const size_t influence_offset =
            static_cast<size_t>(vertex_index) * counts.max_influence_count + influence_index;
        const float weight = compiled.skinning_weights[influence_offset];
        if (weight == 0.0f) {
          continue;
        }
        const uint32_t joint_index = compiled.skinning_indices[influence_offset];
        const float* skin_joint_state =
            impl.skin_transforms.data() + static_cast<size_t>(joint_index) * 8U;
        const Vec3f transformed = apply_point_transformf(
            tuple_transformf(skin_joint_state),
            rest_point);
        skinned.x += transformed.x * weight;
        skinned.y += transformed.y * weight;
        skinned.z += transformed.z * weight;
      }
      impl.output_vertices[base_offset + 0] = skinned.x;
      impl.output_vertices[base_offset + 1] = skinned.y;
      impl.output_vertices[base_offset + 2] = skinned.z;
    }
    impl.timing.skinning_ms = elapsed_ms(stage_start, SteadyClock::now());
  }

  if (skip_derived) {
    impl.derived_valid = false;
  } else {
    const bool derived_dirty =
        !cache_available || !impl.derived_valid || joint_world_dirty || skinning_dirty;
    if (derived_dirty) {
      const auto stage_start = SteadyClock::now();
      float min_skeleton_y = std::numeric_limits<float>::infinity();
      float max_skeleton_y = -std::numeric_limits<float>::infinity();
      for (uint32_t joint_index = 0; joint_index < counts.joint_count; ++joint_index) {
        const float joint_y = impl.skeleton[static_cast<size_t>(joint_index) * 8U + 1U];
        min_skeleton_y = std::min(min_skeleton_y, joint_y);
        max_skeleton_y = std::max(max_skeleton_y, joint_y);
      }
      const size_t root_joint_offset =
          static_cast<size_t>(counts.joint_count > 1U ? 1U : 0U) * 8U;
      impl.derived[0] = impl.skeleton[root_joint_offset + 0U];
      impl.derived[1] = impl.skeleton[root_joint_offset + 1U];
      impl.derived[2] = impl.skeleton[root_joint_offset + 2U];
      impl.derived[3] = impl.output_vertices[0];
      impl.derived[4] = impl.output_vertices[1];
      impl.derived[5] = impl.output_vertices[2];
      impl.derived[6] = max_skeleton_y - min_skeleton_y;
      impl.derived_valid = true;
      impl.timing.derived_stage_ms = elapsed_ms(stage_start, SteadyClock::now());
    }
  }

  impl.cache_available = true;
  impl.evaluated = true;
  impl.model_parameters_dirty = false;
  impl.identity_dirty = false;
  impl.expression_dirty = false;
  impl.last_error.clear();
  impl.timing.evaluate_core_ms = elapsed_ms(evaluate_start, SteadyClock::now());
  return 1;
}

int mhr_get_debug_timing(const MhrData* data, MhrRuntimeDebugTiming* timing) {
  if (data == nullptr || timing == nullptr) {
    return 0;
  }
  *timing = data->impl.timing;
  return 1;
}

int mhr_get_stage_debug(
    const MhrModel* model,
    const MhrData* data,
    uint32_t stage_kind,
    float* out_values,
    uint32_t count) {
  if (model == nullptr || data == nullptr || out_values == nullptr || !data->impl.evaluated) {
    return 0;
  }
  const std::vector<float>* source = nullptr;
  switch (stage_kind) {
    case MHR_STAGE_DEBUG_JOINT_PARAMETERS:
      source = &data->impl.joint_parameters;
      break;
    case MHR_STAGE_DEBUG_LOCAL_SKELETON:
      source = &data->impl.local_transforms;
      break;
    case MHR_STAGE_DEBUG_GLOBAL_SKELETON:
      source = &data->impl.global_transforms;
      break;
    case MHR_STAGE_DEBUG_REST_SURFACE_PRE_CORRECTIVE:
      source = &data->impl.rest_vertices_pre_corrective;
      break;
    case MHR_STAGE_DEBUG_POSE_FEATURES:
      source = &data->impl.pose_features;
      break;
    case MHR_STAGE_DEBUG_HIDDEN:
      source = &data->impl.hidden;
      break;
    case MHR_STAGE_DEBUG_CORRECTIVE_DELTA:
      source = &data->impl.corrective_delta;
      break;
    case MHR_STAGE_DEBUG_REST_SURFACE_POST_CORRECTIVE:
      source = &data->impl.rest_vertices;
      break;
    case MHR_STAGE_DEBUG_SKIN_JOINT_STATES:
      source = &data->impl.skin_transforms;
      break;
    case MHR_STAGE_DEBUG_FINAL_VERTICES:
      source = &data->impl.output_vertices;
      break;
    default:
      return 0;
  }
  if (count != source->size()) {
    return 0;
  }
  std::copy(source->begin(), source->end(), out_values);
  return 1;
}

int mhr_get_vertices(
    const MhrModel* model,
    const MhrData* data,
    float* out_values,
    uint32_t count) {
  if (model == nullptr || data == nullptr || out_values == nullptr || !data->impl.evaluated) {
    return 0;
  }
  if (count != data->impl.output_vertices.size()) {
    return 0;
  }
  std::copy(data->impl.output_vertices.begin(), data->impl.output_vertices.end(), out_values);
  return 1;
}

int mhr_get_skeleton(
    const MhrModel* model,
    const MhrData* data,
    float* out_values,
    uint32_t count) {
  if (model == nullptr || data == nullptr || out_values == nullptr || !data->impl.evaluated) {
    return 0;
  }
  if (count != data->impl.skeleton.size()) {
    return 0;
  }
  std::copy(data->impl.skeleton.begin(), data->impl.skeleton.end(), out_values);
  return 1;
}

int mhr_get_derived(
    const MhrModel* model,
    const MhrData* data,
    float* out_values,
    uint32_t count) {
  if (model == nullptr || data == nullptr || out_values == nullptr ||
      !data->impl.evaluated || !data->impl.derived_valid) {
    return 0;
  }
  if (count != data->impl.derived.size()) {
    return 0;
  }
  std::copy(data->impl.derived.begin(), data->impl.derived.end(), out_values);
  return 1;
}
