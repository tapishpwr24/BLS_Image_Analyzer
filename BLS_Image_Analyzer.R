############################################################
# 0. USER SETTINGS
############################################################

# Software information
BLS_ANALYZER_NAME    <- "BLS Image Analyzer"
BLS_ANALYZER_VERSION <- "1.0.0"

# ----------------------------------------------------------
# INPUT FOLDER
# ----------------------------------------------------------
# Folder containing the leaf images.
#
# "." means the current working directory.
#
# Examples:
#
# Windows:
# INPUT_FOLDER <- "C:/Users/username/Desktop/BLS_images"
#
# macOS:
# INPUT_FOLDER <- "/Users/username/Desktop/BLS_images"
#
# Linux:
# INPUT_FOLDER <- "/home/username/BLS_images"
#
# Recommended for GitHub examples:
# INPUT_FOLDER <- "example_data"

INPUT_FOLDER <- "example_data"


# ----------------------------------------------------------
# OUTPUT FOLDER
# ----------------------------------------------------------
# All results will be written inside this folder.
#
# If a relative path is used, the folder will be created
# relative to the current working directory.

OUTPUT_FOLDER <- "example_output"


# ----------------------------------------------------------
# VISUALIZATION
# ----------------------------------------------------------

OVERLAY_ALPHA <- 0.45


# ----------------------------------------------------------
# IMAGE CLASSIFICATION PARAMETERS
# DO NOT CHANGE unless intentionally recalibrating the method
# ----------------------------------------------------------

LEAF_RGB_SUM_THRESHOLD <- 0.20

NECROTIC_H_MIN <- 0.02
NECROTIC_H_MAX <- 0.10
NECROTIC_S_MIN <- 0.15
NECROTIC_V_MIN <- 0.10
NECROTIC_V_MAX <- 0.50

CHLOROTIC_H_MIN <- 0.10
CHLOROTIC_H_MAX <- 0.24
CHLOROTIC_V_MIN <- 0.28
############################################################
# 1. CHECK AND LOAD REQUIRED PACKAGES
############################################################

needed_pkgs <- c(
  "magick",
  "openxlsx",
  "dplyr",
  "png"
)

missing_pkgs <- needed_pkgs[
  !vapply(
    needed_pkgs,
    requireNamespace,
    quietly = TRUE,
    FUN.VALUE = logical(1)
  )
]

if (length(missing_pkgs) > 0) {
  
  stop(
    paste0(
      "\nMissing required R package(s):\n\n",
      paste0("  - ", missing_pkgs, collapse = "\n"),
      "\n\nInstall them before running BLS Image Analyzer:\n\n",
      "install.packages(c(",
      paste0('"', missing_pkgs, '"', collapse = ", "),
      "))\n"
    ),
    call. = FALSE
  )
}

suppressPackageStartupMessages({
  library(magick)
  library(openxlsx)
  library(dplyr)
})
############################################################
# 2. FIND INPUT IMAGES
############################################################

if (!dir.exists(INPUT_FOLDER)) {
  
  stop(
    paste0(
      "\nInput folder does not exist:\n",
      normalizePath(
        INPUT_FOLDER,
        winslash = "/",
        mustWork = FALSE
      ),
      "\n\nPlease check INPUT_FOLDER in Section 0.\n"
    ),
    call. = FALSE
  )
}


# Detect supported image files
image_files <- list.files(
  path = INPUT_FOLDER,
  pattern = "\\.(jpg|jpeg|png)$",
  full.names = TRUE,
  ignore.case = TRUE
)


if (length(image_files) == 0) {
  
  stop(
    paste0(
      "\nNo compatible leaf images were found.\n\n",
      
      "Input folder:\n",
      normalizePath(
        INPUT_FOLDER,
        winslash = "/",
        mustWork = FALSE
      ),
      
      "\n\nSupported image formats:\n",
      "  JPG\n",
      "  JPEG\n",
      "  PNG\n"
    ),
    call. = FALSE
  )
}


# Sort images alphabetically by filename
image_files <- image_files[
  order(
    tolower(
      basename(image_files)
    )
  )
]


cat("\n")
cat("============================================================\n")
cat(" ", BLS_ANALYZER_NAME, "\n", sep = "")
cat(" Version ", BLS_ANALYZER_VERSION, "\n", sep = "")
cat("============================================================\n\n")

cat(
  "Input folder : ",
  normalizePath(
    INPUT_FOLDER,
    winslash = "/",
    mustWork = FALSE
  ),
  "\n",
  sep = ""
)

cat(
  "Output folder: ",
  normalizePath(
    OUTPUT_FOLDER,
    winslash = "/",
    mustWork = FALSE
  ),
  "\n",
  sep = ""
)

cat(
  "Images found : ",
  length(image_files),
  "\n\n",
  sep = ""
)

cat("Images to analyze:\n")

for (x in basename(image_files)) {
  cat("  - ", x, "\n", sep = "")
}

cat("\n")

############################################################
# 3. CREATE OUTPUT DIRECTORIES
############################################################

output_dir <- normalizePath(
  OUTPUT_FOLDER,
  winslash = "/",
  mustWork = FALSE
)

overlay_dir <- file.path(
  output_dir,
  "01_overlay_images"
)

panel_dir <- file.path(
  output_dir,
  "02_panel_images"
)

viz_overlay_dir <- file.path(
  output_dir,
  "03_overlay_only_plots"
)

viz_diag_dir <- file.path(
  output_dir,
  "04_diagnostic_only_plots"
)

viz_full_dir <- file.path(
  output_dir,
  "05_full_diagnostic_plots"
)

compiled_report_dir <- file.path(
  output_dir,
  "06_compiled_reports"
)

dirs <- c(
  output_dir,
  overlay_dir,
  panel_dir,
  viz_overlay_dir,
  viz_diag_dir,
  viz_full_dir,
  compiled_report_dir
)

for (d in dirs) {
  
  dir.create(
    d,
    recursive = TRUE,
    showWarnings = FALSE
  )
}

############################################################
# 4. BLS SCORE
############################################################

compute_bls_score <- function(
    prop_chlorotic,
    prop_necrotic
) {
  
  diseased_pct <-
    (
      prop_chlorotic +
        prop_necrotic
    ) * 100
  
  
  if (diseased_pct <= 0.5) {
    
    return(1)
    
  } else if (diseased_pct <= 2) {
    
    return(2)
    
  } else if (diseased_pct <= 6) {
    
    return(3)
    
  } else if (diseased_pct <= 12) {
    
    return(4)
    
  } else if (diseased_pct <= 25) {
    
    return(5)
    
  } else if (diseased_pct <= 40) {
    
    return(6)
    
  } else if (diseased_pct <= 60) {
    
    return(7)
    
  } else if (diseased_pct <= 75) {
    
    return(8)
    
  } else {
    
    return(9)
    
  }
}


############################################################
# 5. DISEASE-RESPONSE CATEGORY
############################################################

score_category <- function(score) {
  
  if (is.na(score)) {
    return(NA_character_)
  }
  
  if (score < 3) {
    
    return("Resistant")
    
  } else if (score < 5) {
    
    return("Moderately Resistant")
    
  } else if (score < 7) {
    
    return("Moderately Susceptible")
    
  } else {
    
    return("Highly Susceptible")
  }
}

############################################################
# 6. CORE IMAGE ANALYSIS
############################################################

analyze_leaf_image <- function(img_path) {
  
  if (
    is.na(img_path) ||
    img_path == ""
  ) {
    
    return(NULL)
  }
  
  
  out <- tryCatch({
    
    
    ########################################################
    # Read image
    ########################################################
    
    img <- image_read(img_path)
    
    arr <- image_data(
      img,
      channels = "rgb"
    )
    
    
    ########################################################
    # Magick dimensions
    ########################################################
    
    w <- dim(arr)[2]
    hgt <- dim(arr)[3]
    
    
    ########################################################
    # RGB matrices
    ########################################################
    
    r_mat <- matrix(
      as.numeric(arr[1, , ]) / 255,
      nrow = w,
      ncol = hgt
    )
    
    g_mat <- matrix(
      as.numeric(arr[2, , ]) / 255,
      nrow = w,
      ncol = hgt
    )
    
    b_mat <- matrix(
      as.numeric(arr[3, , ]) / 255,
      nrow = w,
      ncol = hgt
    )
    
    
    # Correct orientation
    r <- t(r_mat)
    g <- t(g_mat)
    b <- t(b_mat)
    
    
    nr <- nrow(r)
    nc <- ncol(r)
    
    
    ########################################################
    # RGB -> HSV
    ########################################################
    
    hsv_vals <- rgb2hsv(
      as.vector(r),
      as.vector(g),
      as.vector(b)
    )
    
    
    h <- matrix(
      hsv_vals[1, ],
      nrow = nr,
      ncol = nc
    )
    
    s <- matrix(
      hsv_vals[2, ],
      nrow = nr,
      ncol = nc
    )
    
    v <- matrix(
      hsv_vals[3, ],
      nrow = nr,
      ncol = nc
    )
    
    
    ########################################################
    # Leaf mask
    ########################################################
    
    leaf_pixels <-
      (r + g + b) >
      LEAF_RGB_SUM_THRESHOLD
    
    
    total_leaf <- sum(
      leaf_pixels,
      na.rm = TRUE
    )
    
    
    if (total_leaf < 100) {
      
      message(
        "Leaf not detected properly: ",
        img_path
      )
      
      return(NULL)
    }
    
    
    ########################################################
    # NECROTIC
    ########################################################
    
    necrotic_pixels <-
      
      leaf_pixels &
      
      (
        
        (
          h >= NECROTIC_H_MIN &
            h <= NECROTIC_H_MAX &
            s >= NECROTIC_S_MIN &
            v >= NECROTIC_V_MIN &
            v <= NECROTIC_V_MAX
        )
        
        |
          
          (
            r > g &
              g > b &
              s >= 0.12 &
              v <= 0.55
          )
        
      )
    
    
    ########################################################
    # CHLOROTIC
    ########################################################
    
    chlorotic_pixels <-
      
      leaf_pixels &
      
      !necrotic_pixels &
      
      (
        
        (
          h >= CHLOROTIC_H_MIN &
            h <= CHLOROTIC_H_MAX &
            v >= CHLOROTIC_V_MIN
        )
        
        |
          
          (
            r >= g * 0.90 &
              g > b * 1.03 &
              v >= 0.30 &
              s >= 0.04
          )
        
      )
    
    
    ########################################################
    # HEALTHY
    ########################################################
    
    healthy_pixels <-
      
      leaf_pixels &
      !necrotic_pixels &
      !chlorotic_pixels
    
    
    ########################################################
    # PIXEL COUNTS
    ########################################################
    
    n_healthy <- sum(
      healthy_pixels,
      na.rm = TRUE
    )
    
    n_chlorotic <- sum(
      chlorotic_pixels,
      na.rm = TRUE
    )
    
    n_necrotic <- sum(
      necrotic_pixels,
      na.rm = TRUE
    )
    
    
    ########################################################
    # PROPORTIONS
    ########################################################
    
    prop_healthy <-
      n_healthy / total_leaf
    
    prop_chlorotic <-
      n_chlorotic / total_leaf
    
    prop_necrotic <-
      n_necrotic / total_leaf
    
    prop_diseased <-
      prop_chlorotic +
      prop_necrotic
    
    
    ########################################################
    # BLS score
    ########################################################
    
    score <- compute_bls_score(
      prop_chlorotic,
      prop_necrotic
    )
    
    
    ########################################################
    # Return everything
    ########################################################
    
    list(
      
      img = img,
      
      width = nc,
      height = nr,
      
      r = r,
      g = g,
      b = b,
      
      h = h,
      s = s,
      v = v,
      
      leaf_pixels = leaf_pixels,
      
      healthy = healthy_pixels,
      chlorotic = chlorotic_pixels,
      necrotic = necrotic_pixels,
      
      diseased =
        chlorotic_pixels |
        necrotic_pixels,
      
      total_leaf = total_leaf,
      
      n_healthy = n_healthy,
      n_chlorotic = n_chlorotic,
      n_necrotic = n_necrotic,
      
      prop_healthy = prop_healthy,
      prop_chlorotic = prop_chlorotic,
      prop_necrotic = prop_necrotic,
      prop_diseased = prop_diseased,
      
      score = score
    )
    
    
  },
  
  error = function(e) {
    
    message(
      "Error analyzing image: ",
      img_path,
      " -> ",
      e$message
    )
    
    NULL
  })
  
  
  return(out)
}


############################################################
# 7. BUILD 3-CLASS OVERLAY
############################################################

build_overlay <- function(res) {
  
  h <- res$height
  w <- res$width
  
  
  overlay <- array(
    0,
    dim = c(h, w, 4)
  )
  
  
  ##########################################################
  # RED = NECROTIC
  ##########################################################
  
  overlay[, , 1] <-
    ifelse(
      res$necrotic,
      1,
      0
    )
  
  
  ##########################################################
  # GREEN = HEALTHY
  ##########################################################
  
  overlay[, , 2] <-
    ifelse(
      res$healthy,
      1,
      0
    )
  
  
  ##########################################################
  # YELLOW = CHLOROTIC
  # Yellow = Red + Green
  ##########################################################
  
  overlay[, , 1] <-
    pmin(
      overlay[, , 1] +
        ifelse(res$chlorotic, 1, 0),
      1
    )
  
  
  overlay[, , 2] <-
    pmin(
      overlay[, , 2] +
        ifelse(res$chlorotic, 1, 0),
      1
    )
  
  
  overlay[, , 3] <- 0
  
  
  ##########################################################
  # Transparency
  ##########################################################
  
  overlay[, , 4] <-
    ifelse(
      res$leaf_pixels,
      OVERLAY_ALPHA,
      0
    )
  
  
  overlay_img <-
    image_read(
      as.raster(overlay)
    )
  
  
  combined <-
    image_composite(
      res$img,
      overlay_img,
      operator = "over"
    )
  
  
  return(combined)
}


############################################################
# 8. SAVE RAW OVERLAY IMAGE
############################################################

save_overlay_image <- function(
    res,
    overlay_path
) {
  
  combined <- build_overlay(res)
  
  image_write(
    combined,
    path = overlay_path,
    format = "png"
  )
  
  invisible(combined)
}


############################################################
# 9. SAVE ORIGINAL + OVERLAY PANEL
# Fixed landscape layout — prevents clipping
############################################################

save_overlay_panel <- function(
    res,
    panel_path
) {
  
  combined <- build_overlay(res)
  
  ##########################################################
  # Fixed panel dimensions
  ##########################################################
  
  CANVAS_W <- 1800
  CANVAS_H <- 1100
  
  HEADER_H <- 130
  LABEL_H  <- 80
  FOOTER_H <- 100
  
  SIDE_MARGIN <- 80
  GAP <- 80
  
  IMAGE_AREA_H <-
    CANVAS_H -
    HEADER_H -
    LABEL_H -
    FOOTER_H
  
  IMAGE_AREA_W <-
    floor(
      (
        CANVAS_W -
          2 * SIDE_MARGIN -
          GAP
      ) / 2
    )
  
  
  ##########################################################
  # Resize images TO FIT — never crop
  ##########################################################
  
  fit_geometry <- paste0(
    IMAGE_AREA_W,
    "x",
    IMAGE_AREA_H,
    ">"
  )
  
  img1 <- image_resize(
    res$img,
    fit_geometry
  )
  
  img2 <- image_resize(
    combined,
    fit_geometry
  )
  
  
  ##########################################################
  # Put each image on identical white canvas
  ##########################################################
  
  img1 <- image_extent(
    img1,
    geometry = paste0(
      IMAGE_AREA_W,
      "x",
      IMAGE_AREA_H
    ),
    gravity = "center",
    color = "white"
  )
  
  img2 <- image_extent(
    img2,
    geometry = paste0(
      IMAGE_AREA_W,
      "x",
      IMAGE_AREA_H
    ),
    gravity = "center",
    color = "white"
  )
  
  
  ##########################################################
  # HEADER
  ##########################################################
  
  header <- image_blank(
    width = CANVAS_W,
    height = HEADER_H,
    color = "white"
  )
  
  header_text <- paste0(
    "BLS Score = ",
    res$score,
    "   |   Diseased = ",
    round(res$prop_diseased * 100, 1),
    "%   |   Healthy = ",
    round(res$prop_healthy * 100, 1),
    "%"
  )
  
  header <- image_annotate(
    header,
    header_text,
    size = 38,
    font = "sans",
    color = "black",
    gravity = "center"
  )
  
  
  ##########################################################
  # LABELS
  ##########################################################
  
  left_label <- image_blank(
    width = IMAGE_AREA_W,
    height = LABEL_H,
    color = "white"
  )
  
  left_label <- image_annotate(
    left_label,
    "Original Image",
    size = 28,
    font = "sans",
    color = "black",
    gravity = "center"
  )
  
  
  right_label <- image_blank(
    width = IMAGE_AREA_W,
    height = LABEL_H,
    color = "white"
  )
  
  right_label <- image_annotate(
    right_label,
    "Classification Overlay",
    size = 28,
    font = "sans",
    color = "black",
    gravity = "center"
  )
  
  
  ##########################################################
  # GAP between images
  ##########################################################
  
  gap_image <- image_blank(
    width = GAP,
    height = IMAGE_AREA_H,
    color = "white"
  )
  
  gap_label <- image_blank(
    width = GAP,
    height = LABEL_H,
    color = "white"
  )
  
  
  ##########################################################
  # SIDE MARGINS
  ##########################################################
  
  left_margin_img <- image_blank(
    width = SIDE_MARGIN,
    height = IMAGE_AREA_H,
    color = "white"
  )
  
  right_margin_img <- image_blank(
    width = SIDE_MARGIN,
    height = IMAGE_AREA_H,
    color = "white"
  )
  
  left_margin_label <- image_blank(
    width = SIDE_MARGIN,
    height = LABEL_H,
    color = "white"
  )
  
  right_margin_label <- image_blank(
    width = SIDE_MARGIN,
    height = LABEL_H,
    color = "white"
  )
  
  
  ##########################################################
  # Assemble label row
  ##########################################################
  
  label_row <- image_append(
    c(
      left_margin_label,
      left_label,
      gap_label,
      right_label,
      right_margin_label
    )
  )
  
  
  ##########################################################
  # Assemble image row
  ##########################################################
  
  image_row <- image_append(
    c(
      left_margin_img,
      img1,
      gap_image,
      img2,
      right_margin_img
    )
  )
  
  
  ##########################################################
  # FOOTER / LEGEND
  ##########################################################
  
  footer <- image_blank(
    width = CANVAS_W,
    height = FOOTER_H,
    color = "white"
  )
  
  footer_text <- paste0(
    "Green = Healthy     |     ",
    "Yellow = Chlorotic     |     ",
    "Red = Necrotic",
    "          ",
    "Chlorotic = ",
    round(res$prop_chlorotic * 100, 1),
    "%     |     Necrotic = ",
    round(res$prop_necrotic * 100, 1),
    "%"
  )
  
  footer <- image_annotate(
    footer,
    footer_text,
    size = 24,
    font = "sans",
    color = "black",
    gravity = "center"
  )
  
  
  ##########################################################
  # FINAL PANEL
  ##########################################################
  
  final_panel <- image_append(
    c(
      header,
      label_row,
      image_row,
      footer
    ),
    stack = TRUE
  )
  
  
  ##########################################################
  # Save
  ##########################################################
  
  image_write(
    final_panel,
    path = panel_path,
    format = "png"
  )
  
  invisible(final_panel)
}

############################################################
# 10. BLS GAUGE
############################################################

plot_bls_gauge <- function(score) {
  
  cols <- rep(
    "grey80",
    9
  )
  
  
  if (score > 1) {
    
    cols[1:(score - 1)] <-
      "#52BE80"
  }
  
  
  cols[score] <-
    "#E74C3C"
  
  
  bp <- barplot(
    
    rep(1, 9),
    
    col = cols,
    
    border = "white",
    
    names.arg = 1:9,
    
    ylim = c(0, 1.35),
    
    main = paste0(
      "BLS Rating: ",
      score,
      " (",
      score_category(score),
      ")"
    ),
    
    ylab = "",
    
    yaxt = "n",
    
    xlab =
      "BLS Rating Scale (1 = healthy, 9 = severe)"
  )
  
  
  text(
    bp[score],
    1.15,
    "\u25B2",
    cex = 1.8
  )
}


############################################################
# 11. LEAF CLASSIFICATION BARPLOT
############################################################

plot_leaf_classification <- function(res) {
  
  props <- c(
    
    res$prop_healthy,
    res$prop_chlorotic,
    res$prop_necrotic
    
  ) * 100
  
  
  bp <- barplot(
    
    props,
    
    names.arg = c(
      "Healthy",
      "Chlorotic",
      "Necrotic"
    ),
    
    col = c(
      "#2ECC71",
      "#F1C40F",
      "#E74C3C"
    ),
    
    border = "white",
    
    ylim = c(
      0,
      max(
        100,
        max(props) + 15
      )
    ),
    
    main =
      "Leaf Area Classification",
    
    ylab =
      "% of leaf area"
  )
  
  
  text(
    
    bp,
    
    props + 3,
    
    labels =
      paste0(
        round(props, 1),
        "%"
      ),
    
    font = 2
  )
}


############################################################
# 12. SAVE OVERLAY-ONLY PLOT
############################################################

save_overlay_plot <- function(
    res,
    plot_path,
    dpi = 150
) {
  
  combined <- build_overlay(res)
  
  
  png(
    filename = plot_path,
    width = 1800,
    height = 1100,
    res = dpi
  )
  
  
  par(
    mfrow = c(1, 2),
    oma = c(0, 0, 3, 0),
    mar = c(2, 2, 4, 2)
  )
  
  
  plot(res$img)
  
  title(
    "Original Image",
    cex.main = 1.2
  )
  
  
  plot(combined)
  
  title(
    paste0(
      "Overlay\n",
      "Green = Healthy | ",
      "Yellow = Chlorosis | ",
      "Red = Necrosis"
    ),
    cex.main = 1.0
  )
  
  
  mtext(
    
    paste0(
      "BLS Score = ",
      res$score,
      "   |   Diseased = ",
      round(
        res$prop_diseased * 100,
        1
      ),
      "%"
    ),
    
    outer = TRUE,
    
    cex = 1.3,
    
    font = 2
  )
  
  
  dev.off()
}


############################################################
# 13. SAVE DIAGNOSTIC-ONLY PLOT
############################################################

save_diagnostic_only <- function(
    res,
    plot_path,
    dpi = 150
) {
  
  png(
    filename = plot_path,
    width = 1800,
    height = 1200,
    res = dpi
  )
  
  
  par(
    mfrow = c(2, 2),
    oma = c(0, 0, 3, 0)
  )
  
  
  ##########################################################
  # Hue
  ##########################################################
  
  hist(
    
    res$h[res$leaf_pixels],
    
    breaks = 40,
    
    main =
      "Leaf Pixel Hue Distribution",
    
    xlab =
      "Hue (0-1)",
    
    col = "grey"
  )
  
  
  abline(
    v = c(
      CHLOROTIC_H_MIN,
      CHLOROTIC_H_MAX
    ),
    lty = 2
  )
  
  
  ##########################################################
  # Saturation
  ##########################################################
  
  hist(
    
    res$s[res$leaf_pixels],
    
    breaks = 40,
    
    main =
      "Leaf Pixel Saturation",
    
    xlab =
      "Saturation (0-1)",
    
    col = "grey"
  )
  
  
  ##########################################################
  # Brightness
  ##########################################################
  
  hist(
    
    res$v[res$leaf_pixels],
    
    breaks = 40,
    
    main =
      "Leaf Pixel Brightness",
    
    xlab =
      "Value (0-1)",
    
    col = "grey"
  )
  
  
  ##########################################################
  # Classification
  ##########################################################
  
  plot_leaf_classification(res)
  
  
  mtext(
    
    paste0(
      "BLS Score = ",
      res$score,
      "   |   Diseased = ",
      round(
        res$prop_diseased * 100,
        1
      ),
      "%"
    ),
    
    outer = TRUE,
    
    cex = 1.3,
    
    font = 2
  )
  
  
  dev.off()
}


############################################################
# 14. SAVE FULL 6-PANEL DIAGNOSTIC
############################################################

save_full_diagnostic <- function(
    res,
    img_name,
    plot_path,
    dpi = 150
) {
  
  combined <- build_overlay(res)
  
  
  png(
    filename = plot_path,
    width = 2400,
    height = 1500,
    res = dpi
  )
  
  
  par(
    
    mfrow = c(2, 3),
    
    oma = c(0, 0, 4, 0),
    
    mar = c(4, 4, 4, 2)
  )
  
  
  ##########################################################
  # PANEL 1 — ORIGINAL
  ##########################################################
  
  plot(res$img)
  
  title(
    "Original Image",
    cex.main = 1.1
  )
  
  
  ##########################################################
  # PANEL 2 — OVERLAY
  ##########################################################
  
  plot(combined)
  
  title(
    paste0(
      "Overlay\n",
      "Green = Healthy | ",
      "Yellow = Chlorosis | ",
      "Red = Necrosis"
    ),
    cex.main = 0.95
  )
  
  
  ##########################################################
  # PANEL 3 — BLS GAUGE
  ##########################################################
  
  plot_bls_gauge(
    res$score
  )
  
  
  ##########################################################
  # PANEL 4 — HUE
  ##########################################################
  
  hist(
    
    res$h[res$leaf_pixels],
    
    breaks = 40,
    
    main =
      "Leaf Pixel Hue Distribution",
    
    xlab =
      "Hue (0-1)",
    
    col =
      "slategray",
    
    border =
      "white"
  )
  
  
  abline(
    
    v = c(
      CHLOROTIC_H_MIN,
      CHLOROTIC_H_MAX
    ),
    
    lty = 2,
    
    lwd = 2
  )
  
  
  ##########################################################
  # PANEL 5 — BRIGHTNESS
  ##########################################################
  
  hist(
    
    res$v[res$leaf_pixels],
    
    breaks = 40,
    
    main =
      "Leaf Pixel Brightness Distribution",
    
    xlab =
      "Brightness / Value (0-1)",
    
    col =
      "goldenrod",
    
    border =
      "white"
  )
  
  
  ##########################################################
  # PANEL 6 — CLASSIFICATION
  ##########################################################
  
  plot_leaf_classification(res)
  
  
  ##########################################################
  # MAIN TITLE
  ##########################################################
  
  title_text <- paste0(
    
    "BLS Diagnostic - ",
    img_name,
    
    "   |   BLS = ",
    res$score,
    
    "   |   Diseased = ",
    round(
      res$prop_diseased * 100,
      1
    ),
    "%",
    
    "   |   Healthy = ",
    round(
      res$prop_healthy * 100,
      1
    ),
    "%",
    
    "   |   Chlorosis = ",
    round(
      res$prop_chlorotic * 100,
      1
    ),
    "%",
    
    "   |   Necrosis = ",
    round(
      res$prop_necrotic * 100,
      1
    ),
    "%"
  )
  
  
  mtext(
    
    title_text,
    
    outer = TRUE,
    
    cex = 1.15,
    
    font = 2,
    
    line = 1
  )
  
  
  dev.off()
}


############################################################
# 15. PROCESS ALL IMAGES
############################################################

results_list <- vector(
  "list",
  length(image_files)
)


for (i in seq_along(image_files)) {
  
  img_path <- image_files[i]
  
  img_name <- basename(
    img_path
  )
  
  img_id <-
    tools::file_path_sans_ext(
      img_name
    )
  
  
  cat(
    "\n[",
    i,
    "/",
    length(image_files),
    "] Processing ",
    img_name,
    " ...\n",
    sep = ""
  )
  
  
  res <- analyze_leaf_image(
    img_path
  )
  
  
  if (is.null(res)) {
    
    results_list[[i]] <-
      data.frame(
        
        Image_ID = img_id,
        
        Image_File = img_name,
        
        Leaf_Pixels = NA,
        
        Healthy_Pixels = NA,
        
        Chlorotic_Pixels = NA,
        
        Necrotic_Pixels = NA,
        
        Healthy_Percent = NA,
        
        Chlorotic_Percent = NA,
        
        Necrotic_Percent = NA,
        
        Total_Diseased_Percent = NA,
        
        BLS_Score = NA,
        
        Disease_Response = NA,
        
        QC_Status = "FAILED",
        
        stringsAsFactors = FALSE
      )
    
    
    next
  }
  
  
  ##########################################################
  # Output paths
  ##########################################################
  
  overlay_path <- file.path(
    overlay_dir,
    paste0(
      img_id,
      "_overlay.png"
    )
  )
  
  
  panel_path <- file.path(
    panel_dir,
    paste0(
      img_id,
      "_panel.png"
    )
  )
  
  
  overlay_plot_path <- file.path(
    viz_overlay_dir,
    paste0(
      img_id,
      "_overlay_only.png"
    )
  )
  
  
  diag_plot_path <- file.path(
    viz_diag_dir,
    paste0(
      img_id,
      "_diagnostic_only.png"
    )
  )
  
  
  full_diag_path <- file.path(
    viz_full_dir,
    paste0(
      img_id,
      "_full_diagnostic.png"
    )
  )
  
  
  ##########################################################
  # Save images
  ##########################################################
  
  save_overlay_image(
    res,
    overlay_path
  )
  
  
  save_overlay_panel(
    res,
    panel_path
  )
  
  
  save_overlay_plot(
    res,
    overlay_plot_path
  )
  
  
  save_diagnostic_only(
    res,
    diag_plot_path
  )
  
  
  save_full_diagnostic(
    res,
    img_name,
    full_diag_path
  )
  
  
  ##########################################################
  # QC
  ##########################################################
  
  prop_sum <-
    res$prop_healthy +
    res$prop_chlorotic +
    res$prop_necrotic
  
  
  qc_status <-
    ifelse(
      abs(prop_sum - 1) < 0.0001,
      "PASS",
      "CHECK"
    )
  
  
  ##########################################################
  # Results
  ##########################################################
  
  results_list[[i]] <-
    data.frame(
      
      Image_ID =
        img_id,
      
      Image_File =
        img_name,
      
      Leaf_Pixels =
        res$total_leaf,
      
      Healthy_Pixels =
        res$n_healthy,
      
      Chlorotic_Pixels =
        res$n_chlorotic,
      
      Necrotic_Pixels =
        res$n_necrotic,
      
      Healthy_Percent =
        round(
          res$prop_healthy * 100,
          2
        ),
      
      Chlorotic_Percent =
        round(
          res$prop_chlorotic * 100,
          2
        ),
      
      Necrotic_Percent =
        round(
          res$prop_necrotic * 100,
          2
        ),
      
      Total_Diseased_Percent =
        round(
          res$prop_diseased * 100,
          2
        ),
      
      BLS_Score =
        res$score,
      
      Disease_Response =
        score_category(
          res$score
        ),
      
      QC_Status =
        qc_status,
      
      Overlay_Image =
        overlay_path,
      
      Panel_Image =
        panel_path,
      
      Full_Diagnostic =
        full_diag_path,
      
      stringsAsFactors =
        FALSE
    )
  
  
  cat(
    
    "    Healthy    = ",
    round(
      res$prop_healthy * 100,
      1
    ),
    "%\n",
    
    "    Chlorotic  = ",
    round(
      res$prop_chlorotic * 100,
      1
    ),
    "%\n",
    
    "    Necrotic   = ",
    round(
      res$prop_necrotic * 100,
      1
    ),
    "%\n",
    
    "    Diseased   = ",
    round(
      res$prop_diseased * 100,
      1
    ),
    "%\n",
    
    "    BLS Score  = ",
    res$score,
    "\n",
    
    sep = ""
  )
}


results <- do.call(
  rbind,
  results_list
)


############################################################
# 16. SUMMARY
############################################################

summary_tbl <-
  
  results %>%
  
  summarise(
    
    n_images =
      n(),
    
    n_passed =
      sum(
        QC_Status == "PASS",
        na.rm = TRUE
      ),
    
    mean_healthy_percent =
      round(
        mean(
          Healthy_Percent,
          na.rm = TRUE
        ),
        2
      ),
    
    mean_chlorotic_percent =
      round(
        mean(
          Chlorotic_Percent,
          na.rm = TRUE
        ),
        2
      ),
    
    mean_necrotic_percent =
      round(
        mean(
          Necrotic_Percent,
          na.rm = TRUE
        ),
        2
      ),
    
    mean_total_diseased_percent =
      round(
        mean(
          Total_Diseased_Percent,
          na.rm = TRUE
        ),
        2
      ),
    
    mean_BLS_score =
      round(
        mean(
          BLS_Score,
          na.rm = TRUE
        ),
        2
      )
  )


############################################################
# 17. SAVE CSV
############################################################

csv_path <- file.path(
  output_dir,
  "BLS_results.csv"
)

write.csv(
  results,
  csv_path,
  row.names = FALSE
)


############################################################
# 18. EXCEL REPORT
############################################################

xlsx_path <- file.path(
  output_dir,
  "BLS_results.xlsx"
)


wb <- createWorkbook()


############################################################
# Results sheet
############################################################

addWorksheet(
  wb,
  "Per_Image"
)


writeData(
  wb,
  "Per_Image",
  results
)


header_style <- createStyle(
  textDecoration = "bold",
  fgFill = "#D9EAD3",
  border = "Bottom",
  halign = "center"
)


addStyle(
  wb,
  "Per_Image",
  header_style,
  rows = 1,
  cols = 1:ncol(results),
  gridExpand = TRUE
)


freezePane(
  wb,
  "Per_Image",
  firstRow = TRUE
)


setColWidths(
  wb,
  "Per_Image",
  cols = 1:ncol(results),
  widths = "auto"
)


############################################################
# Summary sheet
############################################################

addWorksheet(
  wb,
  "Summary"
)


writeData(
  wb,
  "Summary",
  summary_tbl
)


addStyle(
  wb,
  "Summary",
  header_style,
  rows = 1,
  cols = 1:ncol(summary_tbl),
  gridExpand = TRUE
)


setColWidths(
  wb,
  "Summary",
  cols = 1:ncol(summary_tbl),
  widths = 22
)


############################################################
# Score scale sheet
############################################################

score_scale <- data.frame(
  
  BLS_Score = 1:9,
  
  Diseased_Percent =
    c(
      "0-0.5",
      ">0.5-2",
      ">2-6",
      ">6-12",
      ">12-25",
      ">25-40",
      ">40-60",
      ">60-75",
      ">75"
    ),
  
  Disease_Response =
    c(
      "Resistant",
      "Resistant",
      "Moderately Resistant",
      "Moderately Resistant",
      "Moderately Susceptible",
      "Moderately Susceptible",
      "Highly Susceptible",
      "Highly Susceptible",
      "Highly Susceptible"
    )
)

addWorksheet(
  wb,
  "BLS_Score_Scale"
)


writeData(
  wb,
  "BLS_Score_Scale",
  score_scale
)


addStyle(
  wb,
  "BLS_Score_Scale",
  header_style,
  rows = 1,
  cols = 1:3,
  gridExpand = TRUE
)


setColWidths(
  wb,
  "BLS_Score_Scale",
  cols = 1:3,
  widths = 25
)


saveWorkbook(
  wb,
  xlsx_path,
  overwrite = TRUE
)


############################################################
# 19. COMPILED PDF REPORT
# One complete panel per landscape PDF page
############################################################

# Find all generated panel images
panel_files <- list.files(
  panel_dir,
  pattern = "_panel\\.png$",
  full.names = TRUE,
  ignore.case = TRUE
)

if (length(panel_files) > 0) {
  
  ##########################################################
  # Sort panel files alphabetically by filename
  ##########################################################
  
  panel_files <- panel_files[
    order(
      tolower(
        basename(panel_files)
      )
    )
  ]
  
  
  ##########################################################
  # Create PDF output path
  ##########################################################
  
  report_pdf_path <- file.path(
    compiled_report_dir,
    paste0(
      "BLS_compiled_panel_report_",
      format(
        Sys.time(),
        "%Y%m%d_%H%M%S"
      ),
      ".pdf"
    )
  )
  
  
  ##########################################################
  # Open landscape PDF
  ##########################################################
  
  pdf(
    file = report_pdf_path,
    width = 11.69,
    height = 8.27,
    onefile = TRUE,
    paper = "special"
  )
  
  
  ##########################################################
  # Add one panel image per PDF page
  ##########################################################
  
  for (panel_file in panel_files) {
    
    panel_img <- png::readPNG(
      panel_file
    )
    
    grid::grid.newpage()
    
    grid::grid.raster(
      panel_img,
      x = 0.5,
      y = 0.5,
      width = grid::unit(
        0.96,
        "npc"
      ),
      height = grid::unit(
        0.96,
        "npc"
      ),
      interpolate = TRUE
    )
  }
  
  
  ##########################################################
  # Close PDF
  ##########################################################
  
  dev.off()
  
  
  ##########################################################
  # Console message
  ##########################################################
  
  cat(
    "\nCompiled PDF report saved:\n",
    report_pdf_path,
    "\n",
    sep = ""
  )
  
} else {
  
  message(
    "No panel images were found. ",
    "Compiled PDF report was not created."
  )
}
############################################################
# 20. FINAL QC
############################################################

cat("\n\n============================================\n")
cat(" ANALYSIS COMPLETE\n")
cat("============================================\n\n")


print(
  results[
    ,
    c(
      "Image_File",
      "Healthy_Percent",
      "Chlorotic_Percent",
      "Necrotic_Percent",
      "Total_Diseased_Percent",
      "BLS_Score",
      "Disease_Response",
      "QC_Status"
    )
  ]
)


cat(
  "\nOutput folder:\n",
  output_dir,
  "\n",
  sep = ""
)


cat(
  "\nCSV:\n",
  csv_path,
  "\n",
  sep = ""
)


cat(
  "\nExcel:\n",
  xlsx_path,
  "\n",
  sep = ""
)


cat("\n============================================\n")
cat(" BLS IMAGE ANALYZER v1.0 FINISHED\n")
cat("============================================\n")

