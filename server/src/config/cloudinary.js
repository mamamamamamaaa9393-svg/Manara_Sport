const cloudinary = require("cloudinary").v2;

function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    console.error(
      "⚠️  Cloudinary environment variables are not fully configured. " +
        "Video upload and delivery will be disabled until CLOUDINARY_CLOUD_NAME, " +
        "CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET are set in the environment."
    );
    return false;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });

  console.log("✅ Cloudinary configured successfully");
  return true;
}

module.exports = { configureCloudinary };