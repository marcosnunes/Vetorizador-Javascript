use wasm_bindgen::prelude::*;
// Correção 1: Usar a nova API do base64
use base64::{engine::general_purpose, Engine as _}; 
// Correção 2: Remover imports não utilizados e manter o que é necessário
use image::{GrayImage}; 
use imageproc::contours::{find_contours, Contour};
// Correção 3: Adicionar o import do ThresholdType
use imageproc::contrast::ThresholdType; 
use geojson::{Feature, FeatureCollection, GeoJson, Geometry, Value};
use serde_json::json;

#[wasm_bindgen]
pub fn vetorizar_imagem(base64_img: &str) -> String {
    // Correção 4: Usar a nova API do base64 para decodificar
    let img_data = match general_purpose::STANDARD.decode(base64_img) {
        Ok(data) => data,
        Err(_) => return "Erro ao decodificar base64".to_string(),
    };

    let img = match image::load_from_memory(&img_data) {
        Ok(img) => img.to_luma8(),
        Err(_) => return "Erro ao carregar imagem".to_string(),
    };

    // Correção 5: Adicionar o terceiro argumento à função threshold
    let binary_img: GrayImage = imageproc::contrast::threshold(&img, 128, ThresholdType::Binary);

    // Correção 6: Remover o segundo argumento da função find_contours
    let contours: Vec<Contour<u32>> = find_contours(&binary_img);

    let features = contours.iter().map(|contour| {
        let coordinates: Vec<Vec<f64>> = contour.points.iter().map(|p| vec![p.x as f64, p.y as f64]).collect();
        let geometry = Geometry::new(Value::LineString(coordinates));
        Feature {
            bbox: None,
            geometry: Some(geometry),
            id: None,
            properties: None,
            foreign_members: None,
        }
    }).collect();

    let feature_collection = FeatureCollection {
        bbox: None,
        features,
        foreign_members: None,
    };

    let geojson = GeoJson::from(feature_collection);
    geojson.to_string()
}